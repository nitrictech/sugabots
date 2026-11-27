export * as TurnTools from "./tools.ts";

import { safeValidateTypes } from "@ai-sdk/provider-utils";
import { FILE_TOOLS, FILE_WRITING_TOOLS } from "@sugabots/contracts";
import type { RequestOperationName } from "@sugabots/contracts/operations";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import type { UserText } from "@sugabots/errors";
import { asSchema, type JSONSchema7, type Tool, type ToolResultPart, type ToolSet } from "ai";
import { Context, Effect, Layer, type Scope } from "effect";
import { type Database, effectRunner } from "../../database/database.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import type { Operations } from "../../operations/registry.ts";
import { canWriteFilesInChat } from "../../proofs/can-change-file.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";
import { ConnectorCalls } from "../../providers/connectors/connector-calls.ts";
import { SearchProviderStore } from "../../providers/search-providers/search-provider-store.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { connectorsPagePath } from "../../server-settings/web-app-paths.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { BotStore } from "../../workspaces/bots/bot-store.ts";
import { TurnComputers } from "../tools/computer/turn-computers.ts";
import { buildCatalog } from "../tools/tool-search/catalog.ts";
import { CALL_TOOL, callToolTool, toolCatalogNote } from "../tools/tool-search/tool.ts";
import { connectorToolsForStep } from "./connector-tools.ts";
import { executionFence, holdTurnForToolWrite } from "./fence.ts";
import type {
	ApprovalAsked,
	ApprovalBinding,
	CallRecord,
	OfferedTool as OfferedToolDefinition,
	StepApproval,
	ToolResultOutput,
	TurnEnvironment,
	TurnSetting,
} from "./loop-values.ts";
import { operationTools } from "./operation-tools.ts";
import { TurnStore } from "./store.ts";
import type { ResultFiles } from "./tool-calls/long-results.ts";
import { ToolApprovalRequired } from "./tool-calls/recorded.ts";

/**
 * The tools a turn's model may call. One directory per tool under `tools/`;
 * this is the only place that knows which ones exist, so adding a tool is a
 * folder and a line here rather than a change to the turn's steps.
 *
 * Three kinds. The built-in tools do work for the bot,
 * the computer tools work in the computer of the project the turn works in
 * (see `TurnContext.projectId`), and the connector tools do work at a server
 * one of the turn's connectors reaches: the project's and the bot's own, the
 * project's winning when both have a connector with the same handle. Every
 * call is recorded as a `tool_call` part of the reply
 * (`tool-calls/recorded.ts`). A bot asks another bot for help by mentioning
 * it in its reply, not through a tool.
 * Connector tools are found through `tool_search` and `call_tool`.
 *
 * A tool that can't run is still offered, and its calls refused: the tools
 * lead the provider's cached prompt, so changing them mid-chat loses the
 * cache.
 */

/**
 * The operations a step offers no tool for, whatever their bounds: a host
 * request where the computer reaches every host not blocked, or where the
 * bot has no computer, and sharing a file outside a project's chat, where
 * no page shows a reply's files.
 */
function withheldOperations(
	setting: TurnSetting,
	computer: TurnComputers.Step,
): ReadonlySet<RequestOperationName> {
	const withheld = new Set<RequestOperationName>();
	if (!computer.asksForHosts) withheld.add("computers.requestHost");
	if (setting.chat.kind !== "project_chat") withheld.add("computers.shareFile");
	return withheld;
}

/**
 * The bot loop's records of a step's tool calls, through `RunningTurn`:
 * each call recorded as sent before it is sent, then finished with what came
 * back. A call that waited for approval is started instead, once allowed,
 * unless its approval no longer holds. Each is recorded once: recording one
 * an earlier execution of the turn recorded says what became of it.
 */
export interface ToolCallRecorder {
	/** Records the call as sent, before it is sent, and places it in the reply. */
	readonly open: (call: {
		readonly toolCallId: string;
		readonly tool: string;
		readonly input: unknown;
		readonly writeOrDelete: boolean;
		/** The tool the call is bound to: a connector's, as configured now, or a built-in one. */
		readonly binding: ApprovalBinding;
	}) => Effect.Effect<CallRecord>;
	/** Records what the recorded call `callId` returned, or how it failed. */
	readonly close: (
		callId: string,
		outcome: { readonly output: unknown } | { readonly error: UserText },
	) => Effect.Effect<void>;
	/**
	 * Starts the allowed call, or undefined when its approval no longer holds,
	 * as when its connector changed after it was allowed.
	 */
	readonly startApproved: (call: {
		readonly toolCallId: string;
		readonly tool: string;
		readonly input: unknown;
		readonly binding: ApprovalBinding;
		readonly writeOrDelete: boolean;
	}) => Effect.Effect<CallRecord | undefined>;
}

/** The turn a step offers tools for. */
export interface StepTurn {
	readonly turnId: string;
	/** Which execution of the turn takes the step, whose writes are fenced on it. */
	readonly executionNumber: number;
	/** The turn's reply, which its tools may attach files to. */
	readonly replyMessageId: string;
	readonly setting: TurnSetting;
	/** The calls of the last step that waited for approval, which must still match what was approved. */
	readonly approvals: readonly StepApproval[];
}

export { type ApprovalAsked, ToolApprovalRequired };

/** The tools one step offers, and what the loop needs to make their calls. */
interface StepTools {
	/** The tools by name, each recording its calls through the recorder as it runs. */
	readonly tools: ToolSet;
	/**
	 * Runs the call to the tool `toolName`, which its input was checked for,
	 * and resolves to what it returned, or the last of what it streamed.
	 * `signal` aborts it.
	 */
	readonly execute: (
		call: { readonly toolName: string; readonly toolCallId: string; readonly input: unknown },
		signal: AbortSignal,
	) => Promise<unknown>;
	/** The tools as the step's model request offers them. */
	readonly offered: readonly OfferedToolDefinition[];
	/** What the turn's first prompt tells the bot of its tools. */
	readonly environment: TurnEnvironment;
	/**
	 * The built-in tool a waiting call was approved for, if that tool has
	 * disappeared. Connector calls check their bindings individually.
	 */
	readonly changedApproval: string | undefined;
	/**
	 * The call's input as its tool's own schema reads it, or what was wrong
	 * with it: the model request sends each tool's schema, but checks no
	 * input against it.
	 */
	readonly checkInput: (call: {
		readonly toolName: string;
		readonly input: unknown;
	}) => Effect.Effect<{ readonly input: unknown } | { readonly invalid: string }>;
	/** What the call `toolName` with `input` waits for approval of, if it waits for one. */
	readonly approvalOf: (
		call: {
			readonly toolName: string;
			readonly input: unknown;
		},
		phase?: "plan" | "requireApproval",
	) => Effect.Effect<ApprovalAsked | false | undefined>;
	/** What the model is given back for a call that returned `output`, as the SDK would give it. */
	readonly modelOutput: (call: {
		readonly toolName: string;
		readonly toolCallId: string;
		readonly input: unknown;
		readonly output: unknown;
	}) => Effect.Effect<ToolResultOutput>;
}

export interface Interface {
	readonly release: ConnectorCalls.Interface["release"];
	/**
	 * The tools step `turn` offers.
	 */
	readonly forStep: <P, T>(
		running: RunsTurn<P, T>,
		operations: Operations.Interface,
		turn: Omit<StepTurn, "turnId" | "executionNumber">,
		recorder: ToolCallRecorder,
	) => Effect.Effect<StepTools, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnTools") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const searchProviders = yield* SearchProviderStore.Service;
	const connectorCalls = yield* ConnectorCalls.Service;
	const turnComputers = yield* TurnComputers.Service;
	const files = yield* ChatFileStore.Service;
	const serverSettings = yield* ServerSettings.Service;
	const turns = yield* TurnStore.Service;
	// A tool runs as a promise, so it needs a way back to this runtime's database.
	const database = yield* Effect.context<Database>();
	const runInTurn = effectRunner({ runPromiseExit: Effect.runPromiseExitWith(database) });

	const forStep: Interface["forStep"] = (running, operations, prepared, recorder) =>
		Effect.gen(function* () {
			const principal = running.principal.value;
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
				return yield* Effect.die(new Error("RunsTurn has no bot principal"));
			}
			const turn = { ...prepared, turnId: running.turn.value, executionNumber: running.execution };
			const { setting } = turn;
			const { workspace: workspaceId, chat: chatId, project: projectId } = running;
			const botId = principal.bot;
			const webEnabled = (yield* searchProviders.resolve(workspaceId)) !== undefined;
			const computer = yield* turnComputers.forStep(principal, {
				workspaceId,
				projectId,
				turnId: turn.turnId,
				chatId,
				botId,
				color: setting.bot.color,
				naturalBrowsing: setting.bot.naturalBrowsing,
				acceptsImages: setting.bot.acceptsImages,
				// A chat serves the files in it, so only there can members be shown one.
				...(setting.chat.kind === "project_chat" && {
					attach: (file) =>
						turns.attachFile(
							{
								turnId: turn.turnId,
								chatId,
								workspaceId,
								botId,
								messageId: turn.replyMessageId,
								executionNumber: turn.executionNumber,
							},
							file,
						),
				}),
			});
			const connectors = yield* connectorCalls.offer(
				principal,
				{ projectId, ownProjectId: setting.bot.defaultProjectId },
				{
					files,
					computer: computer.atPlace,
					computerSignsIn: computer.signsIn,
				},
			);
			const fence = holdTurnForToolWrite(executionFence(turn.turnId, turn.executionNumber));
			const stepFiles: ResultFiles = {
				write: (file) => files.write({ ...file, fence }),
			};
			const recording = {
				recorder,
				files: stepFiles,
				run: runInTurn,
				chatId,
			};
			const dispatched = operationTools(
				principal,
				operations,
				turn,
				recording,
				withheldOperations(setting, computer),
			);
			for (const name of setting.bot.disabledTools) {
				if (FILE_TOOLS.has(name)) dispatched.delete(name);
			}
			const fileWritesOffered =
				[...dispatched.keys()].some((name) => FILE_WRITING_TOOLS.has(name)) &&
				(yield* canWriteFilesInChat(principal));
			const offeredInRequest = (name: string) => fileWritesOffered || !FILE_WRITING_TOOLS.has(name);
			const connectorDispatch = connectorToolsForStep(
				principal,
				operations,
				connectorCalls,
				connectors.tools,
				turn,
				recording,
			);
			let changedApproval: string | undefined;
			for (const { tool, binding } of turn.approvals) {
				if (binding.kind === "built-in" && !dispatched.has(tool)) {
					changedApproval ??= tool;
				}
			}
			const catalog = buildCatalog(connectors.tools, {});
			const tools: ToolSet = {
				[CALL_TOOL]: callToolTool({ catalog, tools: connectorDispatch.dispatched }),
			};
			for (const [name, entry] of dispatched) tools[name] = entry.tool;
			const botConnectorsPageUrl = `${serverSettings.webAppUrl}${connectorsPagePath({ workspaceSlug: setting.workspaceSlug, botHandle: setting.bot.handle })}`;
			// The turn's connectors are its bot's default project's and, in a
			// project members made, that project's, which the chat is in.
			const connectorsPageUrlOf = (projectId: string) =>
				setting.project && projectId !== setting.bot.defaultProjectId
					? `${serverSettings.webAppUrl}${connectorsPagePath({ workspaceSlug: setting.workspaceSlug, projectSlug: setting.project.slug })}`
					: botConnectorsPageUrl;
			const environment: TurnEnvironment = {
				builtInTools: [
					...(webEnabled
						? [WEB_FETCH_TOOL, WEB_SEARCH_TOOL].filter(
								(key) => tools[key] && !setting.bot.disabledTools.includes(key),
							)
						: []),
					...Object.keys(tools).filter((key) => FILE_TOOLS.has(key) && offeredInRequest(key)),
				],
				toolCatalog: toolCatalogNote({
					catalog,
					unavailable: connectors.unavailable,
					signInExpired: connectors.signInExpired.map(({ handle, projectId }) => ({
						handle,
						connectorsPageUrl: connectorsPageUrlOf(projectId),
					})),
					instructions: connectors.instructions,
					addable: connectors.addable,
					fromProjectAndBot: connectors.fromProjectAndBot,
					connectorsPageUrl: botConnectorsPageUrl,
				}),
				computer: computer.note,
			};
			const offered = yield* Effect.forEach(
				Object.entries(tools).filter(([name]) => offeredInRequest(name)),
				([name, offeredTool]) =>
					Effect.map(inputJsonSchema(offeredTool), (inputSchema) => ({
						name,
						// None of Sugabots' tools describes itself from its call's context.
						...(typeof offeredTool.description === "string"
							? { description: offeredTool.description }
							: {}),
						inputSchema: { ...inputSchema },
					})),
			);
			const approvalOf: StepTools["approvalOf"] = (call, phase) =>
				Effect.gen(function* () {
					const operation = dispatched.get(call.toolName);
					if (operation) {
						const checked = yield* checkInput(call);
						return "invalid" in checked
							? false
							: yield* Effect.promise(() =>
									operation.approval(checked.input, phase === "requireApproval"),
								);
					}
					return call.toolName === CALL_TOOL
						? yield* connectorDispatch.approval(call.input, phase)
						: undefined;
				});
			const modelOutput: StepTools["modelOutput"] = (call) =>
				Effect.promise(async (): Promise<ToolResultOutput> => {
					const used = tools[call.toolName];
					if (used?.toModelOutput) {
						return await used.toModelOutput({
							toolCallId: call.toolCallId,
							input: call.input,
							output: call.output,
						});
					}
					return defaultModelOutput(call.output);
				});
			const checkInput: StepTools["checkInput"] = (call) =>
				Effect.promise(async () => {
					const used = tools[call.toolName];
					if (!used) return { invalid: `No tool is called ${call.toolName}.` };
					const checked = await safeValidateTypes({
						value: call.input,
						schema: asSchema(used.inputSchema),
					});
					return checked.success
						? { input: checked.value }
						: {
								invalid: `The input didn't match the tool's input schema, so it wasn't run: ${checked.error.message}`,
							};
				});
			const execute: StepTools["execute"] = async (call, signal) => {
				const run = tools[call.toolName]?.execute;
				if (!run) throw new Error(`No tool is called ${call.toolName}`);
				return lastOutput(
					run(call.input as never, {
						toolCallId: call.toolCallId,
						messages: [],
						abortSignal: signal,
						context: undefined,
					}),
				);
			};
			return {
				tools,
				execute,
				offered,
				environment,
				changedApproval,
				checkInput,
				approvalOf,
				modelOutput,
			};
		}).pipe(
			// This runtime's services fill in what the step's own context lacks, and
			// the step's win.
			Effect.updateContext((step: Context.Context<Scope.Scope>) => Context.merge(database, step)),
		);

	return Service.of({ forStep, release: connectorCalls.release });
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide(
		Layer.mergeAll(TurnStore.layer, BotStore.layer, ChatFileStore.layer, SearchProviderStore.layer),
	),
);

/** A tool's output: the value it returned, or the last its stream of outputs gave. */
async function lastOutput(result: unknown): Promise<unknown> {
	const awaited = await result;
	if (awaited === null || typeof awaited !== "object" || !(Symbol.asyncIterator in awaited)) {
		return awaited;
	}
	let last: unknown;
	for await (const output of awaited as AsyncIterable<unknown>) last = output;
	return last;
}

/** The JSON Schema of `offered`'s input, as its model request sends it. */
const inputJsonSchema = (offered: Tool) =>
	Effect.promise(async (): Promise<JSONSchema7> => await asSchema(offered.inputSchema).jsonSchema);

/** What the model is given back for an output its tool has no rule for, as the model SDK gives it. */
function defaultModelOutput(output: unknown): ToolResultPart["output"] {
	return typeof output === "string"
		? { type: "text", value: output }
		: { type: "json", value: (output ?? null) as never };
}

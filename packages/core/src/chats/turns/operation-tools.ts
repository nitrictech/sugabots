import {
	botLoopTools,
	type InputOf,
	type OfferedIn,
	operationContracts,
	type RequestOperationName,
} from "@sugabots/contracts/operations";
import { type DomainError, UserText } from "@sugabots/errors";
import { type FlexibleSchema, jsonSchema, type Tool, tool } from "ai";
import { Effect, Schema } from "effect";
import { turnFacts } from "../../authentication/turn-facts.ts";
import { query } from "../../database/database.ts";
import type { Operations } from "../../operations/registry.ts";
import type { BotPrincipal } from "../../principal.ts";
import { type ApprovalRule, approvalNeed, approvalRule } from "../../proofs/approved.ts";
import { canWriteBrief } from "../../proofs/may-brief.ts";
import { docsPageList } from "../chats/read-docs.ts";
import { offeredBrowserTools } from "../tools/browser/browser.ts";
import { ToolCallError } from "../tools/failed.ts";
import { hasImages, withImages } from "../tools/images.ts";
import { recordedCallOf } from "../tools/recorded-call.ts";
import { checkApproval } from "./approval-check.ts";
import { type RecordingOptions, recorded, ToolApprovalRequired } from "./tool-calls/recorded.ts";
import type { ApprovalAsked, StepTurn } from "./tools.ts";

const offeredOperations = botLoopTools(operationContracts) satisfies ReadonlyArray<{
	readonly operation: RequestOperationName;
}>;

/** An operation the bot loop offers as a tool. */
type OfferedOperation = (typeof offeredOperations)[number]["operation"];

function isOfferedIn(
	name: OfferedOperation,
	bounds: OfferedIn,
	principal: BotPrincipal,
	setting: StepTurn["setting"],
) {
	if (name === "chats.startBriefedChat" && !canWriteBrief(setting.reason)) return false;
	// A Personal Assistant's instructions are Sugabots', so it has none of its own to save.
	if (name === "bots.saveInstructions" && setting.bot.assistantOf !== null) return false;
	// The workspace guide is a Personal Assistant's own: other personal bots have
	// member bounds too, but aren't the workspace's guide.
	if (name === "workspaces.guide" && setting.bot.assistantOf === null) return false;
	if (name === "automations.createWithRoutine" || name === "automations.updateInChat") {
		if (setting.projectId === null) return false;
		if (
			setting.projectId === setting.bot.defaultProjectId &&
			setting.chat.kind !== "project_chat"
		) {
			return false;
		}
	}
	switch (bounds) {
		case "everywhere":
			return true;
		case "chatBounds":
			return principal._tag === "BotForAsker" && setting.reason !== "automation";
		case "ownChats":
			return (
				principal._tag === "BotForAsker" &&
				setting.chat.kind === "project_chat" &&
				setting.projectId === setting.bot.defaultProjectId
			);
		case "memberBounds":
			return principal.bounds.kind === "member";
	}
}

/** One tool an offered operation is called through, as the model sees it. */
interface OperationTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: FlexibleSchema<unknown>;
	/** The operation's input for the model's input to the tool. */
	readonly operationInput: (input: unknown) => unknown;
	readonly rule: ApprovalRule;
}

/**
 * The tools `name` is offered through: its own, named in the manifest, or for
 * the browser, one for each browser tool, named and described as the
 * browser's server lists it, each calling the operation with its name and the
 * model's arguments, and recorded and approved under its own name.
 */
function toolsOf(name: OfferedOperation, acceptsImages: boolean): readonly OperationTool[] {
	const { description, input } = operationContracts[name];
	const rule = approvalRule(name);
	if (name === "computers.useBrowser") {
		return offeredBrowserTools(acceptsImages).map((browserTool) => ({
			name: browserTool.name,
			description: browserTool.description,
			inputSchema: jsonSchema(browserTool.inputSchema as Parameters<typeof jsonSchema>[0]),
			operationInput: (input) =>
				({
					tool: browserTool.name,
					arguments: input as Record<string, unknown>,
				}) satisfies InputOf<"computers.useBrowser">,
			rule: { ...rule, tool: browserTool.name },
		}));
	}
	return [
		{
			name: rule.tool,
			description:
				name === "chats.readDocs"
					? `${description}\n\nPages and section headings:\n${docsPageList}`
					: description,
			inputSchema: input.pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			operationInput: (input) => input,
			rule,
		},
	];
}

/**
 * The tools the step offers that call operations. `withheld` are operations
 * the step offers no tool for, whatever their bounds, such as sharing a file
 * where no page shows a reply's files.
 */
export function operationTools(
	principal: BotPrincipal,
	operations: Operations.Interface,
	turn: StepTurn,
	recording: RecordingOptions,
	withheld: ReadonlySet<RequestOperationName> = new Set(),
) {
	const { acceptsImages } = turn.setting.bot;
	return new Map(
		offeredOperations.flatMap(({ operation: name, offeredIn }) => {
			if (
				name === "connectors.callTool" ||
				withheld.has(name) ||
				!isOfferedIn(name, offeredIn, principal, turn.setting)
			)
				return [];
			return toolsOf(name, acceptsImages).map((offered) =>
				operationTool(principal, operations, turn, recording, name, offered),
			);
		}),
	);
}

function operationTool(
	principal: BotPrincipal,
	operations: Operations.Interface,
	turn: StepTurn,
	recording: RecordingOptions,
	name: OfferedOperation,
	{ name: toolName, description, inputSchema, operationInput, rule }: OperationTool,
) {
	const binding = { kind: "built-in" } as const;
	const check = (input: unknown) =>
		checkApproval((call) => operations[name](principal, operationInput(input) as never, call));
	const ask = (input: unknown, details: NonNullable<Effect.Success<ReturnType<typeof check>>>) =>
		({ tool: rule.tool, input, binding, ...details }) satisfies ApprovalAsked;
	const approval = (
		input: unknown,
		planned?: boolean,
	): Promise<ApprovalAsked | false | undefined> =>
		recording.run(
			Effect.gen(function* () {
				const facts = yield* query((db) => turnFacts(db, principal.turn));
				if (!facts) return false as const;
				if (!planned && approvalNeed(facts, rule) !== "approver") return undefined;
				const details = yield* check(input);
				return details ? ask(input, details) : (false as const);
			}),
		);
	const operation: Tool = tool({
		description,
		inputSchema,
		execute: (input, { context, abortSignal }) => {
			const callId = recordedCallOf(context);
			if (!callId) throw new Error(`Tool ${toolName} has no recorded call`);
			// The tool's schema decoded the model's input before the recorder opened the call.
			const dispatch: Effect.Effect<unknown, DomainError> = operations[name](
				principal,
				operationInput(input) as never,
				{ kind: "toolCall", toolCall: callId },
			);
			return recording.run(
				dispatch.pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							if (error._tag === "ApprovalNeeded") {
								const details = yield* check(input);
								if (details)
									return yield* Effect.fail(
										new ToolApprovalRequired({
											...ask(input, details),
											reopenCallId: callId,
										}),
									);
							}
							return yield* Effect.fail(new ToolCallError({ userMessage: error.userMessage }));
						}),
					),
					Effect.catchDefect((defect) =>
						Effect.gen(function* () {
							yield* Effect.logError("Operation tool failed", {
								operation: name,
								toolCallId: callId,
								defect,
							});
							return yield* Effect.fail(
								new ToolCallError({
									userMessage: UserText.unchecked(
										`The tool failed before it finished. Reference: ${callId}.`,
									),
								}),
							);
						}),
					),
				),
				abortSignal ? { signal: abortSignal } : undefined,
			);
		},
		// A result with images, such as a screenshot, shows them to a model that takes them.
		toModelOutput: ({ output }) =>
			hasImages(output)
				? withImages(output, turn.setting.bot.acceptsImages)
				: typeof output === "string"
					? { type: "text", value: output }
					: { type: "json", value: (output ?? null) as never },
	});
	const send = recorded(toolName, operation, { ...recording, writeOrDelete: rule.changes });
	const approved = recorded(toolName, operation, {
		...recording,
		writeOrDelete: rule.changes,
		approval: { binding },
	});
	const waiting = new Set(
		turn.approvals.filter((call) => call.tool === toolName).map((call) => call.toolCallId),
	);
	return [
		toolName,
		{
			tool: {
				...send,
				execute: (input: unknown, options: Parameters<NonNullable<typeof send.execute>>[1]) => {
					const call = waiting.has(options.toolCallId) ? approved : send;
					return call.execute?.(input, options);
				},
			},
			approval,
		},
	] as const;
}

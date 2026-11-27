import { type InputOf, operationContracts } from "@sugabots/contracts/operations";
import { userText } from "@sugabots/errors";
import { jsonSchema, type Tool } from "ai";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { turnFacts } from "../../authentication/turn-facts.ts";
import { query } from "../../database/database.ts";
import { connector } from "../../database/schema.ts";
import type { Operations } from "../../operations/registry.ts";
import type { BotPrincipal } from "../../principal.ts";
import { approvalNeed, approvalRule } from "../../proofs/approved.ts";
import type { ConnectorCalls } from "../../providers/connectors/connector-calls.ts";
import { toolAccessOf } from "../../providers/connectors/tool-access.ts";
import type { OfferedTool } from "../tools/connector-catalog.ts";
import { failed, ToolCallError } from "../tools/failed.ts";
import { recordedCallOf } from "../tools/recorded-call.ts";
import { connectorCallInput } from "../tools/tool-search/tool.ts";
import { checkApproval } from "./approval-check.ts";
import type { ApprovalBinding } from "./loop-values.ts";
import { type RecordingOptions, recorded, ToolApprovalRequired } from "./tool-calls/recorded.ts";
import type { ApprovalAsked, StepTurn } from "./tools.ts";

type Target = Omit<OfferedTool, "tool">;
const operation = "connectors.callTool";
const rule = approvalRule(operation);
const decodeInput = Schema.decodeUnknownOption(operationContracts[operation].input);

function connectorBinding(target: Target): ApprovalBinding {
	return {
		kind: "connector",
		connectorId: target.connectorId,
		connectorRevision: target.connectorRevision,
		remoteToolName: target.remoteToolName,
	};
}

export function connectorToolsForStep(
	principal: BotPrincipal,
	operations: Operations.Interface,
	calls: ConnectorCalls.Interface,
	tools: Readonly<Record<string, Target>>,
	turn: StepTurn,
	recording: RecordingOptions,
) {
	const prepare = (target: Target, args: Record<string, unknown>) =>
		Effect.gen(function* () {
			const parsed = decodeInput({
				connectorId: target.connectorId,
				tool: target.remoteToolName,
				arguments: args,
			});
			if (parsed._tag === "None")
				return { invalid: "This connector tool is unavailable." } as const;
			const checked = yield* calls.validateArguments(
				principal,
				target.connectorId,
				target.remoteToolName,
				parsed.value.arguments,
			);
			if ("invalid" in checked) return checked;
			return { ...parsed.value, arguments: checked.arguments };
		});

	const check = (input: InputOf<typeof operation>) =>
		checkApproval((call) => operations[operation](principal, input, call));

	const approval = (
		input: unknown,
		planned?: boolean,
	): Effect.Effect<ApprovalAsked | false | undefined> =>
		Effect.promise(() =>
			recording.run(
				Effect.gen(function* () {
					const call = connectorCallInput(tools, input);
					const target = call && tools[call.key];
					if (!call || !target) return false as const;
					const [policy] = yield* query((db) =>
						db
							.select({ access: connector.toolAccess })
							.from(connector)
							.where(eq(connector.id, target.connectorId))
							.limit(1),
					);
					if (!policy) return false as const;
					const facts = yield* query((db) => turnFacts(db, principal.turn));
					if (!facts) return false as const;
					const need = approvalNeed(facts, rule, {
						access: toolAccessOf(policy.access, target.described),
						writeOrDelete: target.writeOrDelete,
					});
					if (need === "refused") return false as const;
					if (!planned && need !== "approver") return undefined;
					const decoded = yield* prepare(target, call.arguments);
					if ("invalid" in decoded) return false as const;
					const details = yield* check(decoded);
					if (!details?.connectorAccess) return false as const;
					if (
						approvalNeed(facts, rule, {
							access: details.connectorAccess,
							writeOrDelete: details.writeOrDelete,
						}) !== "approver"
					)
						return undefined;
					return {
						tool: call.key,
						input: decoded.arguments,
						binding: connectorBinding(target),
						...details,
					};
				}),
			),
		);

	const waiting = new Map(turn.approvals.map(({ toolCallId, binding }) => [toolCallId, binding]));
	const keys = new Set([
		...Object.keys(tools),
		...turn.approvals.flatMap(({ tool, binding }) => (binding.kind === "connector" ? [tool] : [])),
	]);
	const dispatched: Record<string, Tool> = Object.fromEntries(
		[...keys].map((key) => {
			const target = tools[key];
			const inputSchema = jsonSchema(target?.inputSchema ?? { type: "object" });
			const adapter: Tool = {
				inputSchema,
				execute: async (input, options) => {
					const parked = waiting.get(options.toolCallId);
					const binding =
						parked?.kind === "connector" ? parked : target && connectorBinding(target);
					if (binding?.kind !== "connector")
						return failed(userText`This connector tool is unavailable.`);
					const args = input as Record<string, unknown>;
					const current =
						target &&
						target.connectorId === binding.connectorId &&
						target.connectorRevision === binding.connectorRevision &&
						target.remoteToolName === binding.remoteToolName
							? target
							: undefined;
					const decoded = current
						? await recording.run(prepare(current, args))
						: decodeUnavailable(binding, args);
					if ("invalid" in decoded)
						return failed(
							userText`The arguments do not match the tool’s input schema. Search for the tool and try again.`,
						);
					const writeOrDelete = current?.writeOrDelete ?? false;
					const send: Tool = {
						inputSchema,
						execute: (_args, { context, abortSignal }) => {
							const callId = recordedCallOf(context);
							if (!callId) throw new Error("Connector tool has no recorded call");
							return recording.run(
								operations[operation](principal, decoded, {
									kind: "toolCall",
									toolCall: callId,
								}).pipe(
									Effect.catch((error) =>
										Effect.gen(function* () {
											if (error._tag === "ApprovalNeeded" && current) {
												const details = yield* check(decoded);
												if (details)
													return yield* Effect.fail(
														new ToolApprovalRequired({
															tool: key,
															input: decoded.arguments,
															binding,
															...details,
															reopenCallId: callId,
														}),
													);
											}
											return yield* Effect.fail(
												new ToolCallError({ userMessage: error.userMessage }),
											);
										}),
									),
								),
								abortSignal ? { signal: abortSignal } : undefined,
							);
						},
					};
					return recorded(key, send, {
						...recording,
						binding,
						writeOrDelete,
						...(parked ? { approval: { binding } } : {}),
					}).execute?.(decoded.arguments, options);
				},
			};
			return [key, adapter];
		}),
	);

	return { approval, dispatched };
}

function decodeUnavailable(
	binding: Extract<ApprovalBinding, { kind: "connector" }>,
	args: Record<string, unknown>,
) {
	const input = decodeInput({
		connectorId: binding.connectorId,
		tool: binding.remoteToolName,
		arguments: args,
	});
	return input._tag === "Some"
		? input.value
		: ({ invalid: "This connector tool is unavailable." } as const);
}

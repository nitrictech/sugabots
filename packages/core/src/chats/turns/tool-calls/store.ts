export * as ToolCallStore from "./store.ts";

import { isDeepStrictEqual } from "node:util";
import type { JsonValue, ToolCallPart } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { and, asc, eq, exists, inArray, type SQL } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import {
	type Database,
	query,
	serviceOperations,
	type Transaction,
	transaction,
	writtenRow,
} from "../../../database/database.ts";
import {
	chat,
	connector,
	member,
	projectBot,
	type ToolCallRow,
	toolCall,
	turn,
} from "../../../database/schema.ts";
import { ChatEvents } from "../../chat-events.ts";
import { ChatEvent, type ToolCallChange } from "../../events.ts";
import { toToolCallPart } from "../../store/tool-calls.ts";
import { withImagesCounted } from "../../tools/images.ts";
import { mayRunTools } from "../lifecycle.ts";
import { WorkAdmission } from "../work-admission.ts";
import {
	type ApprovalDecision,
	isFinished,
	ToolCallEvent,
	type ToolCallState,
	transition,
	UNFINISHED_STATUSES,
} from "./lifecycle.ts";

/**
 * The only writer of `tool_call`: what a bot's reply asked a tool, whether
 * a member allowed it, and what it got.
 *
 * Each command locks the call, asks `lifecycle.ts` what the command makes of
 * it, writes that and emits it, in one transaction. A command the lifecycle
 * refuses writes nothing.
 *
 * A call is opened when the tool starts and closed when it returns, each in
 * its own transaction, so a reader watching the chat sees the call appear
 * and then resolve. The reply keeps a reference to the call among its parts at
 * the point it was made; the input and output live here, so the tool never
 * writes the row the reply being written is saved to.
 */
export interface Interface {
	/** Records that a tool needing no approval has been called. */
	readonly open: (input: {
		chatId: string;
		messageId: string;
		turnId: string;
		tool: string;
		input: unknown;
		/** How far into the reply's text the call was made. */
		atOffset: number;
		/** Whether the tool may change something at the other end. */
		writeOrDelete: boolean;
	}) => Effect.Effect<ToolCallPart>;
	/** Records what the tool returned or how it failed. `undefined` if the call is not running. */
	readonly close: (
		toolCallId: string,
		outcome: ToolCallOutcome,
	) => Effect.Effect<ToolCallPart | undefined>;
	/** Parks the calls a reply asked for until members decide them. */
	readonly requestApprovals: (
		reply: { chatId: string; messageId: string; turnId: string },
		approvals: readonly PendingToolApproval[],
	) => Effect.Effect<void>;
	/**
	 * Records a decision on an approval in the chat. `false`, changing
	 * nothing, once it is decided: the first decision recorded stands.
	 */
	readonly recordDecision: (input: {
		chatId: string;
		approvalId: string;
		decision: ApprovalDecision;
	}) => Effect.Effect<boolean>;
	/**
	 * Starts an allowed call, if it is exactly the call that was approved, its
	 * turn may still run tools, its connector is configured as it was when
	 * approved, and its automation run, if any, still takes work (see
	 * `WorkAdmission`).
	 */
	readonly beginExecution: (input: {
		chatId: string;
		messageId: string;
		turnId: string;
		sdkToolCallId: string;
		tool: string;
		input: unknown;
		binding: ApprovalBinding;
	}) => Effect.Effect<BeganExecution>;
	/**
	 * Fails these turns' unfinished calls, denying pending approvals, for turns
	 * that ended before their tools returned. `userMessage` is what members are
	 * told of each call.
	 */
	readonly abandonUnfinished: (
		turnIds: readonly string[],
		userMessage: UserText,
	) => Effect.Effect<void>;
	/** Forgets a reply's calls, for a retry that starts the reply again. */
	readonly forgetReply: (messageId: string) => Effect.Effect<void>;
	/** What the turn's completed calls to `tools` returned, oldest first. */
	readonly completedOutputs: (
		turnId: string,
		tools: readonly string[],
	) => Effect.Effect<JsonValue[]>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ToolCallStore",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ToolCallStore");
	const { emit } = yield* ChatEvents.Service;
	const admission = yield* WorkAdmission.Service;

	/** Applies `event` to a locked call and writes the result. `undefined` when the lifecycle refuses. */
	const apply = Effect.fn("ToolCallStore.apply")(function* (
		row: ToolCallRow,
		event: ToolCallEvent,
	) {
		const decided = transition(stateOf(row), event);
		if (decided._tag === "Refused") return undefined;
		const next = decided.state;
		const now = yield* DateTime.nowAsDate;
		return yield* query((db) =>
			db
				.update(toolCall)
				.set({
					status: next.status,
					approvalStatus: next.approvalStatus,
					decidedById: next.decidedById,
					output: next.output,
					error: next.error,
					...(event._tag === "Decide" ? { decidedAt: now } : {}),
					...(event._tag === "BeginExecution" ? { startedAt: now } : {}),
					...(isFinished(next.status) && !isFinished(row.status) ? { finishedAt: now } : {}),
				})
				.where(eq(toolCall.id, row.id))
				.returning(),
		).pipe(Effect.flatMap(writtenRow("tool_call")));
	});

	return Service.of({
		open: (input) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const startedAt = yield* DateTime.nowAsDate;
						const row = yield* query((db) =>
							db
								.insert(toolCall)
								.values({
									chatId: input.chatId,
									messageId: input.messageId,
									turnId: input.turnId,
									tool: input.tool,
									input: boundedJson(input.input),
									atOffset: input.atOffset,
									writeOrDelete: input.writeOrDelete,
									startedAt,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("tool_call")));
						yield* emit([ChatEvent.ToolCallStarted(toolCallChange(row))]);
						return toToolCallPart(row);
					}),
				),
			),

		close: (toolCallId, outcome) =>
			operation(
				"close",
				transaction(
					Effect.gen(function* () {
						const row = yield* lockedCall(eq(toolCall.id, toolCallId));
						if (!row) return undefined;
						const closed = yield* apply(
							row,
							ToolCallEvent.Close({
								outcome:
									"error" in outcome
										? outcome
										: { output: boundedJson(withImagesCounted(outcome.output)) },
							}),
						);
						if (!closed) return undefined;
						yield* emit([ChatEvent.ToolCallFinished(toolCallChange(closed))]);
						return toToolCallPart(closed);
					}),
				),
			),

		requestApprovals: (reply, approvals) =>
			operation(
				"requestApprovals",
				transaction(
					Effect.gen(function* () {
						if (approvals.length === 0) return;
						const rows = yield* query((db) =>
							db
								.insert(toolCall)
								.values(
									approvals.map((approval) => ({
										id: approval.id,
										chatId: reply.chatId,
										messageId: reply.messageId,
										turnId: reply.turnId,
										tool: approval.tool,
										sdkToolCallId: approval.sdkToolCallId,
										approvalId: approval.approvalId,
										approvalStatus: "pending" as const,
										approvalReason: approval.reason ?? null,
										...bindingColumns(approval.binding),
										input: boundedJson(approval.input),
										executionInput: executionJson(approval.input),
										status: "awaiting_approval" as const,
										writeOrDelete: approval.writeOrDelete,
										atOffset: approval.atOffset,
									})),
								)
								.returning(),
						);
						// In the order the reply asked for them, which is how the chat lists them.
						const byId = new Map(rows.map((row) => [row.id, row]));
						yield* emit(
							approvals.flatMap((approval) => {
								const row = byId.get(approval.id);
								return row ? [ChatEvent.ToolCallStarted(toolCallChange(row))] : [];
							}),
						);
					}),
				),
			),

		recordDecision: (input) =>
			operation(
				"recordDecision",
				transaction(
					Effect.gen(function* () {
						const row = yield* lockedCall(
							and(eq(toolCall.chatId, input.chatId), eq(toolCall.approvalId, input.approvalId)),
						);
						if (!row) return false;
						const decided = yield* apply(row, ToolCallEvent.Decide({ decision: input.decision }));
						if (!decided) return false;
						// The approver is left-joined, as they may have left since deciding.
						const [placed] = yield* query((db) =>
							db
								.select({
									workspaceId: chat.workspaceId,
									approverName: member.name,
								})
								.from(chat)
								.leftJoin(member, eq(member.id, input.decision.memberId))
								.where(eq(chat.id, decided.chatId))
								.limit(1),
						);
						if (!placed) return yield* Effect.die(new Error("A decided call's chat is missing"));
						yield* emit([
							ChatEvent.ToolCallDecided({
								...toolCallChange(decided, placed.approverName),
								workspaceId: placed.workspaceId,
							}),
						]);
						return true;
					}),
				),
			),

		beginExecution: (input) =>
			operation(
				"beginExecution",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<BeganExecution, never, Database | Transaction> {
						if (!(yield* admission.admits(input.chatId))) {
							return refusedExecution("The automation run takes no more work");
						}
						const [scope] = yield* query((db) =>
							db
								.select({
									workspaceId: chat.workspaceId,
									botId: turn.botId,
									status: turn.status,
									interruptRequested: turn.interruptRequested,
								})
								.from(turn)
								.innerJoin(chat, eq(chat.id, turn.chatId))
								.where(and(eq(turn.id, input.turnId), eq(turn.chatId, input.chatId)))
								.limit(1)
								.for("update", { of: turn }),
						);
						if (!scope || !mayRunTools(scope)) return refusedExecution("The turn is not running");
						const { binding } = input;
						if (binding.kind === "connector") {
							const [approvedConnector] = yield* query((db) =>
								db
									.select({ toolAccess: connector.toolAccess })
									.from(connector)
									.where(
										and(
											eq(connector.id, binding.connectorId),
											eq(connector.workspaceId, scope.workspaceId),
											// The project's or the bot's own: one of the projects it is in.
											exists(
												db
													.select({ projectId: projectBot.projectId })
													.from(projectBot)
													.where(
														and(
															eq(projectBot.projectId, connector.projectId),
															eq(projectBot.botId, scope.botId),
														),
													),
											),
											eq(connector.configurationRevision, binding.connectorRevision),
										),
									)
									.limit(1)
									.for("update"),
							);
							if (!approvedConnector) {
								return refusedExecution("The connector's configuration changed after approval");
							}
							// Choosing what bots may do with a tool leaves the revision alone, so
							// a tool somebody turned off after the approval is caught here.
							if (approvedConnector.toolAccess[binding.remoteToolName] === "off") {
								return refusedExecution("The tool was turned off after approval");
							}
						}
						const row = yield* lockedCall(
							and(
								eq(toolCall.turnId, input.turnId),
								eq(toolCall.sdkToolCallId, input.sdkToolCallId),
							),
						);
						// Every call bound to an approval was parked for a member to allow first.
						if (!row) return refusedExecution("The call has no approval record");
						if (!sameCallAsApproved(row, input)) {
							return refusedExecution(
								"The call was already claimed, or no longer matches what was approved",
							);
						}
						const running = yield* apply(row, ToolCallEvent.BeginExecution());
						if (!running) return refusedExecution("The call is not approved for execution");
						yield* emit([ChatEvent.ToolCallExecuting(toolCallChange(running))]);
						return { _tag: "Running", call: running };
					}),
				),
			),

		abandonUnfinished: (turnIds, userMessage) =>
			operation(
				"abandonUnfinished",
				transaction(
					Effect.gen(function* () {
						if (turnIds.length === 0) return;
						const unfinished = yield* query((db) =>
							db
								.select()
								.from(toolCall)
								.where(
									and(
										inArray(toolCall.turnId, [...turnIds]),
										inArray(toolCall.status, [...UNFINISHED_STATUSES]),
									),
								)
								.orderBy(toolCall.createdAt, toolCall.id)
								.for("update"),
						);
						const abandoned = yield* Effect.forEach(unfinished, (row) =>
							apply(row, ToolCallEvent.Abandon({ userMessage })),
						);
						yield* emit(
							abandoned.flatMap((row) =>
								row ? [ChatEvent.ToolCallFinished(toolCallChange(row))] : [],
							),
						);
					}),
				),
			),

		forgetReply: (messageId) =>
			operation(
				"forgetReply",
				query((db) => db.delete(toolCall).where(eq(toolCall.messageId, messageId))).pipe(
					Effect.asVoid,
				),
			),

		completedOutputs: (turnId, tools) =>
			operation(
				"completedOutputs",
				Effect.map(
					query((db) =>
						db
							.select({ output: toolCall.output })
							.from(toolCall)
							.where(
								and(
									eq(toolCall.turnId, turnId),
									inArray(toolCall.tool, [...tools]),
									eq(toolCall.status, "completed"),
								),
							)
							.orderBy(asc(toolCall.startedAt)),
					),
					(rows) => rows.flatMap(({ output }) => (output === null ? [] : [output])),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** Stored inputs and outputs are cut at this many characters of JSON. */
const MAX_STORED_JSON_CHARACTERS = 64_000;

type ToolCallOutcome = { output: unknown } | { error: UserText };

/**
 * What an approved call must still match when it runs, beyond its tool and
 * input: for a connector's tool, the connector configured as it was when
 * the member allowed it. A built-in tool is the same tool wherever it runs.
 */
export type ApprovalBinding =
	| {
			readonly kind: "connector";
			readonly connectorId: string;
			readonly connectorRevision: number;
			readonly remoteToolName: string;
	  }
	| { readonly kind: "built-in" };

/** A tool call a reply asked for, to be parked until a member decides it. */
export interface PendingToolApproval {
	id: string;
	approvalId: string;
	sdkToolCallId: string;
	tool: string;
	input: unknown;
	reason?: string;
	binding: ApprovalBinding;
	/** Whether the tool may change something, as opposed to one the connector's `ask` holds back. */
	writeOrDelete: boolean;
	atOffset: number;
}

/** A started call, or why it may not start; `reason` is for the logs. */
type BeganExecution =
	| { readonly _tag: "Running"; readonly call: ToolCallRow }
	| { readonly _tag: "Refused"; readonly reason: string };

/**
 * The value as JSON will keep it, cut down when it is too large to store. The
 * round trip through text is what drops `undefined` and anything else JSON
 * cannot carry; the cut keeps the start, which is where a page's title and a
 * result list's first entries are.
 */
function boundedJson(value: unknown): JsonValue {
	const text = JSON.stringify(value ?? null) ?? "null";
	if (text.length <= MAX_STORED_JSON_CHARACTERS) {
		return JSON.parse(text);
	}
	return {
		truncated: true,
		characters: text.length,
		preview: text.slice(0, MAX_STORED_JSON_CHARACTERS),
	};
}

/** The complete input, as JSON keeps it, for running the call exactly as it was approved. */
function executionJson(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null));
}

const lockedCall = (condition: SQL | undefined) =>
	Effect.map(
		query((db) => db.select().from(toolCall).where(condition).limit(1).for("update")),
		([row]) => row,
	);

function stateOf(row: ToolCallRow): ToolCallState {
	return {
		status: row.status,
		approvalStatus: row.approvalStatus,
		decidedById: row.decidedById,
		output: row.output,
		error: row.error,
	};
}

function refusedExecution(reason: string): BeganExecution {
	return { _tag: "Refused", reason };
}

/** sameCallAsApproved reports whether the call about to run is the one a member saw and allowed. */
function sameCallAsApproved(
	row: ToolCallRow,
	input: Parameters<Interface["beginExecution"]>[0],
): boolean {
	return (
		row.chatId === input.chatId &&
		row.messageId === input.messageId &&
		row.tool === input.tool &&
		isDeepStrictEqual(
			{
				connectorId: row.connectorId,
				connectorRevision: row.connectorRevision,
				remoteToolName: row.remoteToolName,
			},
			bindingColumns(input.binding),
		) &&
		isDeepStrictEqual(row.executionInput, executionJson(input.input))
	);
}

/** How a binding is stored on the call: a built-in tool's leaves the connector's columns empty. */
function bindingColumns(binding: ApprovalBinding) {
	return binding.kind === "connector"
		? {
				connectorId: binding.connectorId,
				connectorRevision: binding.connectorRevision,
				remoteToolName: binding.remoteToolName,
			}
		: { connectorId: null, connectorRevision: null, remoteToolName: null };
}

/** The call as an event carries it once it has changed. */
function toolCallChange(row: ToolCallRow, decidedByName: string | null = null): ToolCallChange {
	return {
		chatId: row.chatId,
		messageId: row.messageId,
		toolCall: toToolCallPart(row, decidedByName),
	};
}

export * as ToolCallRepository from "./repository.ts";

import { isDeepStrictEqual } from "node:util";
import type { JsonValue, ToolCallPart } from "@sugabots/contracts";
import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
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
	connection,
	type ToolCallRow,
	thread,
	toolCall,
	turn,
	user,
} from "../../../database/schema.ts";
import type { UserMessage } from "../../../user-message.ts";
import { ConversationEvents } from "../../conversation-events.ts";
import { ConversationEvent, type ToolCallChange } from "../../events.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";
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
 * The only writer of `tool_call`: what an agent's reply asked a tool, whether
 * a person allowed it, and what it got.
 *
 * Each command locks the call, asks `lifecycle.ts` what the command makes of
 * it, writes that and emits it, in one transaction. A command the lifecycle
 * refuses writes nothing.
 *
 * A call is opened when the tool starts and closed when it returns, each in
 * its own transaction, so a reader watching the thread sees the call appear
 * and then resolve. The reply keeps a reference to the call among its parts at
 * the point it was made; the input and output live here, so the tool never
 * writes the row the streaming reply is being saved to.
 */
export interface Interface {
	/** Records that a tool needing no approval has been called. */
	readonly open: (input: {
		threadId: string;
		messageId: string;
		turnId: string;
		tool: string;
		input: unknown;
		/** How far into the reply's text the call was made. */
		atOffset: number;
		/** Whether the tool may change something at the other end. Off when left out. */
		mutating?: boolean;
	}) => Effect.Effect<ToolCallPart>;
	/** Records what the tool returned or how it failed. `undefined` if the call is not running. */
	readonly close: (
		toolCallId: string,
		outcome: ToolCallOutcome,
	) => Effect.Effect<ToolCallPart | undefined>;
	/** Parks the calls a reply asked for until people decide them. */
	readonly requestApprovals: (
		reply: { threadId: string; messageId: string; turnId: string },
		approvals: readonly PendingToolApproval[],
	) => Effect.Effect<void>;
	/**
	 * Records a decision on an approval in the thread. `false`, changing
	 * nothing, once it is decided: the first decision recorded stands.
	 */
	readonly recordDecision: (input: {
		threadId: string;
		approvalId: string;
		decision: ApprovalDecision;
	}) => Effect.Effect<boolean>;
	/**
	 * Starts an allowed call, if it is exactly the call that was approved, its
	 * turn may still run tools, its connection is configured as it was when
	 * approved, and its routine run, if any, still takes work (see
	 * `WorkAdmission`).
	 */
	readonly beginExecution: (input: {
		threadId: string;
		messageId: string;
		turnId: string;
		sdkToolCallId: string;
		tool: string;
		input: unknown;
		connectionId: string;
		connectionRevision: number;
		remoteToolName: string;
	}) => Effect.Effect<BeganExecution>;
	/**
	 * Fails these turns' unfinished calls, denying pending approvals, for turns
	 * that ended before their tools returned. `userMessage` is what people are
	 * told of each call.
	 */
	readonly abandonUnfinished: (
		turnIds: readonly string[],
		userMessage: UserMessage,
	) => Effect.Effect<void>;
	/** Forgets a reply's calls, for a retry that starts the reply again. */
	readonly forgetReply: (messageId: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ToolCallRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ToolCallRepository");
	const { emit } = yield* ConversationEvents.Service;
	const admission = yield* WorkAdmission.Service;

	/** Applies `event` to a locked call and writes the result. `undefined` when the lifecycle refuses. */
	const apply = Effect.fn("ToolCallRepository.apply")(function* (
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
									threadId: input.threadId,
									messageId: input.messageId,
									turnId: input.turnId,
									tool: input.tool,
									input: boundedJson(input.input),
									atOffset: input.atOffset,
									mutating: input.mutating ?? false,
									startedAt,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("tool_call")));
						yield* emit([ConversationEvent.ToolCallStarted(toolCallChange(row))]);
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
								outcome: "error" in outcome ? outcome : { output: boundedJson(outcome.output) },
							}),
						);
						if (!closed) return undefined;
						yield* emit([ConversationEvent.ToolCallFinished(toolCallChange(closed))]);
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
										threadId: reply.threadId,
										messageId: reply.messageId,
										turnId: reply.turnId,
										tool: approval.tool,
										sdkToolCallId: approval.sdkToolCallId,
										approvalId: approval.approvalId,
										approvalStatus: "pending" as const,
										approvalReason: approval.reason ?? null,
										connectionId: approval.connectionId,
										connectionRevision: approval.connectionRevision,
										remoteToolName: approval.remoteToolName,
										input: boundedJson(approval.input),
										executionInput: executionJson(approval.input),
										status: "awaiting_approval" as const,
										mutating: approval.mutating,
										atOffset: approval.atOffset,
									})),
								)
								.returning(),
						);
						// In the order the reply asked for them, which is how the thread lists them.
						const byId = new Map(rows.map((row) => [row.id, row]));
						yield* emit(
							approvals.flatMap((approval) => {
								const row = byId.get(approval.id);
								return row ? [ConversationEvent.ToolCallStarted(toolCallChange(row))] : [];
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
							and(eq(toolCall.threadId, input.threadId), eq(toolCall.approvalId, input.approvalId)),
						);
						if (!row) return false;
						const decided = yield* apply(row, ToolCallEvent.Decide({ decision: input.decision }));
						if (!decided) return false;
						// The decider is left-joined, as they may have left since deciding.
						const [placed] = yield* query((db) =>
							db
								.select({
									workspaceId: thread.workspaceId,
									podId: thread.podId,
									deciderName: user.name,
								})
								.from(thread)
								.leftJoin(user, eq(user.id, input.decision.userId))
								.where(eq(thread.id, decided.threadId))
								.limit(1),
						);
						if (!placed) return yield* Effect.die(new Error("A decided call's thread is missing"));
						yield* emit([
							ConversationEvent.ToolCallDecided({
								...toolCallChange(decided, placed.deciderName),
								workspaceId: placed.workspaceId,
								podId: placed.podId,
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
						if (!(yield* admission.admits(input.threadId))) {
							return refusedExecution("The routine run takes no more work");
						}
						const [scope] = yield* query((db) =>
							db
								.select({
									workspaceId: thread.workspaceId,
									podId: thread.podId,
									status: turn.status,
									cancelRequested: turn.cancelRequested,
								})
								.from(turn)
								.innerJoin(thread, eq(thread.id, turn.threadId))
								.where(and(eq(turn.id, input.turnId), eq(turn.threadId, input.threadId)))
								.limit(1)
								.for("update", { of: turn }),
						);
						if (!scope || !mayRunTools(scope)) return refusedExecution("The turn is not running");
						const [approvedConnection] = yield* query((db) =>
							db
								.select({ id: connection.id })
								.from(connection)
								.where(
									and(
										eq(connection.id, input.connectionId),
										eq(connection.workspaceId, scope.workspaceId),
										eq(connection.podId, scope.podId),
										ne(connection.access, "off"),
										eq(connection.configurationRevision, input.connectionRevision),
									),
								)
								.limit(1)
								.for("update"),
						);
						if (!approvedConnection) {
							return refusedExecution("The connection's configuration changed after approval");
						}
						const row = yield* lockedCall(
							and(
								eq(toolCall.turnId, input.turnId),
								eq(toolCall.sdkToolCallId, input.sdkToolCallId),
							),
						);
						// Every call to a connection's tool was parked for a person to allow first.
						if (!row) return refusedExecution("The call has no approval record");
						if (!sameCallAsApproved(row, input)) {
							return refusedExecution(
								"The call was already claimed, or no longer matches what was approved",
							);
						}
						const running = yield* apply(row, ToolCallEvent.BeginExecution());
						if (!running) return refusedExecution("The call is not approved for execution");
						yield* emit([ConversationEvent.ToolCallExecuting(toolCallChange(running))]);
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
								row ? [ConversationEvent.ToolCallFinished(toolCallChange(row))] : [],
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
	});
});

export const layer = Layer.effect(Service, make);

/** Stored inputs and outputs are cut at this many characters of JSON. */
export const MAX_STORED_JSON_CHARACTERS = 64_000;

export type ToolCallOutcome = { output: unknown } | { error: UserMessage };

/** A connection tool call a reply asked for, to be parked until a person decides it. */
export interface PendingToolApproval {
	id: string;
	approvalId: string;
	sdkToolCallId: string;
	tool: string;
	input: unknown;
	reason?: string;
	connectionId: string;
	connectionRevision: number;
	remoteToolName: string;
	/** Whether the tool may change something, as opposed to one the connection's `ask` holds back. */
	mutating: boolean;
	atOffset: number;
}

/** A started call, or why it may not start; `reason` is for the logs. */
export type BeganExecution =
	| { readonly _tag: "Running"; readonly call: ToolCallRow }
	| { readonly _tag: "Refused"; readonly reason: string };

/**
 * The value as JSON will keep it, cut down when it is too large to store. The
 * round trip through text is what drops `undefined` and anything else JSON
 * cannot carry; the cut keeps the start, which is where a page's title and a
 * result list's first entries are.
 */
export function boundedJson(value: unknown): JsonValue {
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

/** sameCallAsApproved reports whether the call about to run is the one a person saw and allowed. */
function sameCallAsApproved(
	row: ToolCallRow,
	input: Parameters<Interface["beginExecution"]>[0],
): boolean {
	return (
		row.threadId === input.threadId &&
		row.messageId === input.messageId &&
		row.tool === input.tool &&
		row.connectionId === input.connectionId &&
		row.connectionRevision === input.connectionRevision &&
		row.remoteToolName === input.remoteToolName &&
		isDeepStrictEqual(row.executionInput, executionJson(input.input))
	);
}

/** The call as an event carries it once it has changed. */
function toolCallChange(row: ToolCallRow, decidedByName: string | null = null): ToolCallChange {
	return {
		threadId: row.threadId,
		messageId: row.messageId,
		toolCall: toToolCallPart(row, decidedByName),
	};
}

import { type Message, messagePartsFor } from "@sugabots/contracts";
import type { ModelMessage } from "ai";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { type Database, query, type Transaction, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import {
	message,
	type StoredMessagePart,
	type TurnReason,
	thread,
	toolCall,
	turn,
} from "../../database/schema.ts";
import type { UserMessage } from "../../user-message.ts";
import { ConversationEvent } from "../events.ts";
import { threadRejectsTurns } from "../routines/execution.ts";
import { type ParticipantRow, toMessage } from "../threads/participants.ts";
import type { PendingToolApproval, ToolCallRepository } from "../tools/calls/repository.ts";
import {
	ACTIVE_STATUSES,
	type Ended,
	endedAs,
	type FollowUp,
	runsAgainAfterFailure,
	TURN_CANCELLED,
	TURN_STOPPED_UNEXPECTEDLY,
	TurnEvent,
	type TurnState,
	transition,
} from "./lifecycle.ts";
import type { ModelAccounting } from "./model.ts";

/**
 * The only writer of `turn`, and of a turn's reply message while the turn
 * runs: what it says so far, and how it ended.
 *
 * Each command locks the turn, asks `lifecycle.ts` what the command makes of
 * it, writes that and emits it, in one transaction. A command the lifecycle
 * refuses writes nothing. Commands that end a turn's run also end its
 * unfinished tool calls, through `ToolCallRepository`.
 *
 * An agent's turn writes a reply into its thread; the Scribe's turns write
 * summaries instead, so they have commands of their own and announce nothing.
 */
export interface TurnRepository {
	/**
	 * Opens the turn an agent takes on a trigger message, with its reply: starts
	 * it, or reopens it for another run. A turn that may not run again says
	 * why, and how it ended if opening it ended it.
	 */
	openReplyTurn(
		request: ReplyTurnRequest,
	): Effect.Effect<OpenedReplyTurn | NotRunnable, never, Database>;
	/** Opens the Scribe's turn on a message it summarises to, as `openReplyTurn` does. */
	openScribeTurn(
		request: ScribeTurnRequest,
	): Effect.Effect<OpenedScribeTurn | NotRunnable, never, Database>;
	/** Persists the reply so far, so a crash loses at most a second of text. */
	saveReply(turn: ReplyTurn, draft: ReplyDraft): Effect.Effect<void, never, Database>;
	/**
	 * Parks the turn with this model transcript until people decide the tool
	 * approvals it asked for. `false` when the turn is no longer running,
	 * somebody asked it to stop, or its routine run takes no more turns.
	 */
	suspend(
		turn: ReplyTurn,
		checkpoint: TurnCheckpoint,
		approvals: readonly PendingToolApproval[],
	): Effect.Effect<boolean, never, Database>;
	complete(
		turn: ReplyTurn,
		draft: ReplyDraft,
		accounting: ModelAccounting,
	): Effect.Effect<void, never, Database>;
	/**
	 * Records the run as failed, telling people `userMessage`, and returns
	 * whether the turn runs again (see `runsAgainAfterFailure`).
	 */
	fail(
		turn: ReplyTurn,
		draft: ReplyDraft,
		userMessage: UserMessage,
	): Effect.Effect<boolean, never, Database>;
	/** Stops the run short, keeping the reply written so far. */
	cancel(turn: ReplyTurn, draft: ReplyDraft): Effect.Effect<void, never, Database>;
	completeScribeTurn(
		turnId: string,
		accounting: ModelAccounting,
	): Effect.Effect<void, never, Database>;
	failScribeTurn(turnId: string, userMessage: UserMessage): Effect.Effect<void, never, Database>;
	/** Asks the turn to stop, and says who has to be told. */
	requestCancel(turnId: string): Effect.Effect<CancelRequest, never, Database>;
	/** isCancellationRequested reports whether somebody asked the turn to stop, or it is gone. */
	isCancellationRequested(turnId: string): Effect.Effect<boolean, never, Database>;
	/** Records a turn waiting for approvals as cancelled. Does nothing once it stopped waiting. */
	stopWaiting(request: {
		agentId: string;
		triggerMessageId: string;
	}): Effect.Effect<void, never, Database>;
	/**
	 * Ends the active turn the workflow execution `owner` runs, which will not
	 * run it again. `undefined` if there is none.
	 */
	abandon(
		owner: string,
		outcome: { status: "failed" | "cancelled"; userMessage: UserMessage },
	): Effect.Effect<Ended | undefined, never, Database>;
	/**
	 * Records that a mutating tool crossed its dispatch boundary, so the turn
	 * is not run again after a failure from here on (ADR 002). A fact the
	 * lifecycle reads rather than a transition, so it takes no lock.
	 */
	markActed(turnId: string): Effect.Effect<void, never, Database>;
	/**
	 * Cancels the turns waiting in these threads, and asks the running ones to
	 * stop, because the routine run they work for ended.
	 */
	cancelUnder(threadIds: readonly string[]): Effect.Effect<void, never, Database>;
}

/** Where an agent's turn is: its thread and workspace, and the reply it writes. */
export interface ReplyTurn {
	readonly turnId: string;
	readonly threadId: string;
	readonly workspaceId: string;
	readonly messageId: string;
}

export interface ReplyTurnRequest {
	readonly threadId: string;
	readonly agentId: string;
	readonly triggerMessageId: string;
	/** The agent's model, already resolved: a turn is never opened without one. */
	readonly model: string;
	readonly reason: TurnReason | undefined;
	/** The workflow execution running the turn. */
	readonly owner: string;
	/** Who the reply is shown as. */
	readonly author: ParticipantRow;
}

export interface ScribeTurnRequest {
	readonly threadId: string;
	readonly agentId: string;
	readonly triggerMessageId: string;
	readonly model: string;
}

export interface OpenedReplyTurn {
	readonly _tag: "Opened";
	readonly turnId: string;
	/** The reply, `streaming`. */
	readonly reply: Message;
	/** Where a suspended turn left off; set only when this run continues it. */
	readonly checkpoint: TurnCheckpoint | undefined;
}

export interface OpenedScribeTurn {
	readonly _tag: "Opened";
	readonly turnId: string;
}

/** A turn that may not run. `reason` is for the logs; `ended` is set when opening it ended it. */
export interface NotRunnable {
	readonly _tag: "NotRunnable";
	readonly reason: string;
	readonly ended: Ended | undefined;
}

export type CancelRequest =
	| { readonly _tag: "SignalOwner"; readonly owner: string }
	| { readonly _tag: "Announced" }
	| { readonly _tag: "Refused" };

const PlacedPart = Schema.Struct({ id: Schema.String, atOffset: Schema.Int });

/**
 * The reply as the segment has it so far: the text, and where in that text the
 * agent made each collaboration and tool call. Stored as parts in that order.
 */
export const ReplyDraft = Schema.Struct({
	content: Schema.String,
	collaborations: Schema.Array(PlacedPart),
	toolCalls: Schema.Array(PlacedPart),
	/**
	 * A tool that may have changed something ran. A failed run is then not
	 * retried, since the retry could do it again (ADR 002).
	 */
	acted: Schema.optional(Schema.Boolean),
});
export type ReplyDraft = typeof ReplyDraft.Type;

const MODEL_MESSAGE_ROLES: readonly unknown[] = ["system", "user", "assistant", "tool"];

/**
 * A message the model SDK produced. It is checked no deeper than its role and
 * content: the SDK wrote it, and reads it back whole.
 */
const SdkModelMessage = Schema.declare(
	(value: unknown): value is ModelMessage =>
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		MODEL_MESSAGE_ROLES.includes(value.role) &&
		"content" in value &&
		(typeof value.content === "string" || Array.isArray(value.content)),
);

const OptionalCount = Schema.optional(Schema.Int);

/** Everything a suspended turn needs to continue once its approvals are decided. */
export const TurnCheckpoint = Schema.Struct({
	messages: Schema.Array(SdkModelMessage),
	approvals: Schema.Array(
		Schema.Struct({
			approvalId: Schema.String,
			tool: Schema.String,
			connectionId: Schema.String,
			connectionRevision: Schema.Int,
			remoteToolName: Schema.String,
		}),
	),
	modelInput: Schema.Struct({
		model: Schema.String,
		system: Schema.String,
		messages: Schema.Array(
			Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.String }),
		),
	}),
	reply: ReplyDraft,
	accounting: Schema.Struct({
		usage: Schema.Struct({
			modelCalls: OptionalCount,
			inputTokens: OptionalCount,
			outputTokens: OptionalCount,
			totalTokens: OptionalCount,
			reasoningTokens: OptionalCount,
			cachedInputTokens: OptionalCount,
		}),
		reportedCost: Schema.optional(Schema.Finite),
		contextTokens: OptionalCount,
		contextCapacity: OptionalCount,
	}),
});
export type TurnCheckpoint = typeof TurnCheckpoint.Type;

export function turnRepository(
	emit: DomainEvents.Emit<ConversationEvent>,
	toolCalls: ToolCallRepository,
): TurnRepository {
	/** Writes the state the lifecycle decided, plus what else the command records. */
	const write = (
		turnId: string,
		next: TurnState,
		recorded: Partial<Pick<typeof turn.$inferInsert, "checkpoint" | AccountingColumn>> = {},
	) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(turn)
					.set({
						status: next.status,
						owner: next.owner,
						cancelRequested: next.cancelRequested,
						runs: next.runs,
						error: next.status === "failed" ? next.userMessage : null,
						finishedAt: next.status === "running" || next.status === "waiting" ? null : now,
						...(next.checkpointed ? {} : { checkpoint: null }),
						...recorded,
					})
					.where(eq(turn.id, turnId)),
			);
		});

	/**
	 * Ends the reply and the unfinished tool calls of a turn the lifecycle
	 * ended mid-run, telling people `userMessage` of the calls, and announces
	 * how it ended. A Scribe's turn has no reply, so there is nothing to
	 * announce.
	 */
	const endRun = (turnId: string, state: TurnState, userMessage: UserMessage) =>
		Effect.gen(function* () {
			const ended = endedAs(state);
			const [reply] = yield* query((db) =>
				db
					.select({
						messageId: message.id,
						content: message.content,
						threadId: turn.threadId,
						workspaceId: thread.workspaceId,
					})
					.from(message)
					.innerJoin(turn, eq(turn.id, message.turnId))
					.innerJoin(thread, eq(thread.id, turn.threadId))
					.where(eq(message.turnId, turnId))
					.limit(1),
			);
			if (reply) {
				yield* query((db) =>
					db.update(message).set({ status: ended.state }).where(eq(message.id, reply.messageId)),
				);
			}
			yield* toolCalls.abandonUnfinished([turnId], userMessage);
			if (reply) yield* emit([endAnnouncement({ turnId, ...reply }, ended)]);
			return ended;
		});

	/** Locks the turn found by `condition` and asks the lifecycle what `event` makes of it. */
	const lockAndTransition = (condition: SQL | undefined, event: TurnEvent) =>
		Effect.map(lockedTurn(condition), (locked) =>
			locked
				? { id: locked.id, state: locked.state, decided: transition(locked.state, event) }
				: undefined,
		);

	const writeReply = (
		reply: ReplyTurn,
		draft: ReplyDraft,
		status?: "complete" | "failed" | "cancelled",
	) =>
		query((db) =>
			db
				.update(message)
				.set({ content: draft.content, parts: replyParts(draft), ...(status ? { status } : {}) })
				.where(eq(message.id, reply.messageId)),
		);

	/**
	 * Reopens the turn an existing row holds, as the lifecycle decides, ending
	 * it if the lifecycle says it may not run again.
	 */
	const reopen = (
		existing: { id: string; state: TurnState },
		owner: string | null,
	): Effect.Effect<
		{ _tag: "Reopened"; followUp: FollowUp | undefined } | NotRunnable,
		never,
		Database | Transaction
	> =>
		Effect.gen(function* () {
			const [uncertainMutation] = yield* query((db) =>
				db
					.select({ id: toolCall.id })
					.from(toolCall)
					.where(
						and(
							eq(toolCall.turnId, existing.id),
							eq(toolCall.status, "running"),
							eq(toolCall.mutating, true),
						),
					)
					.limit(1),
			);
			const decided = transition(
				existing.state,
				TurnEvent.Reopen({ owner, uncertainMutation: uncertainMutation !== undefined }),
			);
			if (decided._tag === "Refused") return notRunnable(decided.reason);
			yield* write(existing.id, decided.state);
			if (decided.followUp?._tag !== "End") {
				return { _tag: "Reopened", followUp: decided.followUp };
			}
			const ended = yield* endRun(existing.id, decided.state, decided.followUp.userMessage);
			return notRunnable(decided.followUp.userMessage, ended);
		});

	const insertTurn = (
		request: ScribeTurnRequest & Partial<Pick<ReplyTurnRequest, "reason" | "owner">>,
	) =>
		Effect.gen(function* () {
			const startedAt = yield* DateTime.nowAsDate;
			const [created] = yield* query((db) =>
				db
					.insert(turn)
					.values({
						threadId: request.threadId,
						agentId: request.agentId,
						triggerMessageId: request.triggerMessageId,
						owner: request.owner ?? null,
						runs: 1,
						status: "running",
						reason: request.reason,
						model: request.model,
						startedAt,
					})
					.returning({ id: turn.id }),
			);
			if (!created) return yield* Effect.die(new Error("Turn insert returned no row"));
			return created.id;
		});

	const announceStart = (request: ReplyTurnRequest, turnId: string, reply: Message) =>
		emit([
			ConversationEvent.TurnStarted({
				threadId: request.threadId,
				turnId,
				agentId: request.agentId,
				reply,
			}),
		]);

	return {
		openReplyTurn: (request) =>
			transaction(
				Effect.gen(function* (): Effect.fn.Return<
					OpenedReplyTurn | NotRunnable,
					never,
					Database | Transaction
				> {
					const existing = yield* lockedTurn(onTrigger(request));
					if (!existing) {
						const turnId = yield* insertTurn(request);
						const [created] = yield* query((db) =>
							db
								.insert(message)
								.values({
									threadId: request.threadId,
									authorAgentId: request.agentId,
									kind: "text",
									status: "streaming",
									parts: [],
									content: "",
									turnId,
								})
								.returning(),
						);
						if (!created)
							return yield* Effect.die(new Error("Reply message insert returned no row"));
						const reply = toMessage(created, request.author);
						yield* announceStart(request, turnId, reply);
						return { _tag: "Opened", turnId, reply, checkpoint: undefined };
					}
					const reopened = yield* reopen(existing, request.owner);
					if (reopened._tag === "NotRunnable") return reopened;
					if (reopened.followUp?._tag === "Resume") {
						const [parked] = yield* query((db) =>
							db
								.select({ checkpoint: turn.checkpoint, reply: message })
								.from(turn)
								.innerJoin(message, eq(message.turnId, turn.id))
								.where(eq(turn.id, existing.id))
								.limit(1),
						);
						if (!parked)
							return yield* Effect.die(new Error("A suspended turn has no reply message"));
						const checkpoint = yield* Schema.decodeUnknownEffect(TurnCheckpoint)(
							parked.checkpoint,
						).pipe(Effect.orDie);
						return {
							_tag: "Opened",
							turnId: existing.id,
							reply: toMessage(parked.reply, request.author),
							checkpoint,
						};
					}
					const [restarted] = yield* query((db) =>
						db
							.update(message)
							.set({ status: "streaming", parts: [], content: "" })
							.where(eq(message.turnId, existing.id))
							.returning(),
					);
					if (!restarted) {
						return yield* Effect.die(new Error("A turn being run again has no reply message"));
					}
					// The reply starts again, so the calls its last run made go with its parts.
					yield* toolCalls.forgetReply(restarted.id);
					const reply = toMessage(restarted, request.author);
					yield* announceStart(request, existing.id, reply);
					return { _tag: "Opened", turnId: existing.id, reply, checkpoint: undefined };
				}),
			),

		openScribeTurn: (request) =>
			transaction(
				Effect.gen(function* (): Effect.fn.Return<
					OpenedScribeTurn | NotRunnable,
					never,
					Database | Transaction
				> {
					const existing = yield* lockedTurn(onTrigger(request));
					if (!existing) return { _tag: "Opened", turnId: yield* insertTurn(request) };
					const reopened = yield* reopen(existing, null);
					if (reopened._tag === "NotRunnable") return reopened;
					return { _tag: "Opened", turnId: existing.id };
				}),
			),

		saveReply: (reply, draft) => Effect.asVoid(writeReply(reply, draft)),

		suspend: (reply, checkpoint, approvals) =>
			transaction(
				Effect.gen(function* () {
					if (yield* threadRejectsTurns(reply.threadId)) return false;
					const locked = yield* lockAndTransition(eq(turn.id, reply.turnId), TurnEvent.Suspend());
					if (locked?.decided._tag !== "Next") return false;
					yield* write(locked.id, locked.decided.state, { checkpoint });
					yield* toolCalls.requestApprovals(
						{ threadId: reply.threadId, messageId: reply.messageId, turnId: locked.id },
						approvals,
					);
					yield* writeReply(reply, checkpoint.reply);
					yield* emit([
						ConversationEvent.TurnSuspended({
							threadId: reply.threadId,
							workspaceId: reply.workspaceId,
							turnId: locked.id,
						}),
					]);
					return true;
				}),
			),

		complete: (reply, draft, accounting) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(eq(turn.id, reply.turnId), TurnEvent.Complete());
					if (locked?.decided._tag !== "Next") return;
					yield* writeReply(reply, draft, "complete");
					yield* write(locked.id, locked.decided.state, accountingColumns(accounting));
					yield* emit([
						ConversationEvent.TurnCompleted({
							threadId: reply.threadId,
							workspaceId: reply.workspaceId,
							turnId: locked.id,
							messageId: reply.messageId,
							content: draft.content,
							usage: accounting.usage,
							reportedCost: accounting.reportedCost,
						}),
					]);
				}),
			),

		fail: (reply, draft, userMessage) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(
						eq(turn.id, reply.turnId),
						TurnEvent.Fail({ userMessage }),
					);
					if (locked?.decided._tag !== "Next") return false;
					const willRetry = runsAgainAfterFailure(locked.state, draft.acted ?? false);
					yield* writeReply(reply, draft, "failed");
					yield* write(locked.id, locked.decided.state);
					yield* toolCalls.abandonUnfinished([locked.id], userMessage);
					yield* emit([
						ConversationEvent.TurnFailed({
							threadId: reply.threadId,
							workspaceId: reply.workspaceId,
							turnId: locked.id,
							messageId: reply.messageId,
							userMessage,
							willRetry,
						}),
					]);
					return willRetry;
				}),
			),

		cancel: (reply, draft) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(eq(turn.id, reply.turnId), TurnEvent.Cancel());
					if (locked?.decided._tag !== "Next") return;
					yield* writeReply(reply, draft, "cancelled");
					yield* write(locked.id, locked.decided.state);
					yield* toolCalls.abandonUnfinished([locked.id], TURN_CANCELLED);
					yield* emit([
						ConversationEvent.TurnCancelled({
							threadId: reply.threadId,
							workspaceId: reply.workspaceId,
							turnId: locked.id,
							messageId: reply.messageId,
							content: draft.content,
						}),
					]);
				}),
			),

		completeScribeTurn: (turnId, accounting) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(eq(turn.id, turnId), TurnEvent.Complete());
					if (locked?.decided._tag !== "Next") return;
					yield* write(locked.id, locked.decided.state, accountingColumns(accounting));
				}),
			),

		failScribeTurn: (turnId, userMessage) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(
						eq(turn.id, turnId),
						TurnEvent.Fail({ userMessage }),
					);
					if (locked?.decided._tag !== "Next") return;
					yield* write(locked.id, locked.decided.state);
				}),
			),

		requestCancel: (turnId) =>
			transaction(
				Effect.gen(function* (): Effect.fn.Return<CancelRequest, never, Database | Transaction> {
					const locked = yield* lockedTurn(eq(turn.id, turnId));
					if (!locked) return { _tag: "Refused" };
					const decided = transition(locked.state, TurnEvent.RequestCancel());
					if (decided._tag === "Refused") return { _tag: "Refused" };
					yield* write(turnId, decided.state);
					if (decided.followUp?._tag === "SignalOwner") {
						return { _tag: "SignalOwner", owner: decided.followUp.owner };
					}
					// The worker running it stops on this event; it reads the flag only as a fallback.
					yield* emit([
						ConversationEvent.TurnCancelRequested({ threadId: locked.threadId, turnId }),
					]);
					return { _tag: "Announced" };
				}),
			),

		isCancellationRequested: (turnId) =>
			Effect.map(
				query((db) =>
					db
						.select({ requested: turn.cancelRequested })
						.from(turn)
						.where(eq(turn.id, turnId))
						.limit(1),
				),
				// A turn that has vanished should stop too.
				([row]) => row?.requested ?? true,
			),

		stopWaiting: (request) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(onTrigger(request), TurnEvent.StopWaiting());
					if (locked?.decided._tag !== "Next") return;
					yield* write(locked.id, locked.decided.state);
					if (locked.decided.followUp?._tag === "End") {
						yield* endRun(locked.id, locked.decided.state, locked.decided.followUp.userMessage);
					}
				}),
			),

		abandon: (owner, outcome) =>
			transaction(
				Effect.gen(function* () {
					const locked = yield* lockAndTransition(
						and(eq(turn.owner, owner), inArray(turn.status, [...ACTIVE_STATUSES])),
						TurnEvent.Abandon(outcome),
					);
					if (locked?.decided._tag !== "Next") return undefined;
					yield* write(locked.id, locked.decided.state);
					return yield* endRun(locked.id, locked.decided.state, outcome.userMessage);
				}),
			),

		markActed: (turnId) =>
			query((db) => db.update(turn).set({ mutationStarted: true }).where(eq(turn.id, turnId))).pipe(
				Effect.asVoid,
			),

		cancelUnder: (threadIds) =>
			transaction(
				Effect.gen(function* () {
					if (threadIds.length === 0) return;
					const under = inArray(turn.threadId, [...threadIds]);
					// A waiting turn is waited for, since nobody else will end it. A running
					// one held by its worker is skipped: the worker is recording how it
					// ended, which settles the routine run again.
					const waiting = yield* query((db) =>
						db
							.select(stateColumns)
							.from(turn)
							.where(and(under, eq(turn.status, "waiting")))
							.for("update"),
					);
					const running = yield* query((db) =>
						db
							.select(stateColumns)
							.from(turn)
							.where(and(under, eq(turn.status, "running")))
							.for("update", { skipLocked: true }),
					);
					yield* Effect.forEach(
						[...waiting, ...running],
						(row) =>
							Effect.gen(function* () {
								const decided = transition(stateOf(row), TurnEvent.RoutineEnded());
								if (decided._tag === "Refused") return;
								yield* write(row.id, decided.state);
								if (decided.followUp?._tag === "End") {
									yield* endRun(row.id, decided.state, decided.followUp.userMessage);
								}
							}),
						{ discard: true },
					);
				}),
			),
	};
}

type AccountingColumn = "usage" | "reportedCost" | "contextTokens" | "contextCapacity";

function accountingColumns(accounting: ModelAccounting) {
	return {
		usage: accounting.usage,
		reportedCost: accounting.reportedCost === undefined ? null : String(accounting.reportedCost),
		contextTokens: accounting.contextTokens ?? null,
		contextCapacity: accounting.contextCapacity ?? null,
	};
}

/** The turn an agent takes on a trigger message: there is at most one. */
function onTrigger(request: { agentId: string; triggerMessageId: string }) {
	return and(
		eq(turn.triggerMessageId, request.triggerMessageId),
		eq(turn.agentId, request.agentId),
	);
}

/** What the lifecycle needs to know of a turn, and its id. */
const stateColumns = {
	id: turn.id,
	status: turn.status,
	owner: turn.owner,
	cancelRequested: turn.cancelRequested,
	runs: turn.runs,
	mutationStarted: turn.mutationStarted,
	error: turn.error,
	checkpointed: sql<boolean>`${turn.checkpoint} is not null`,
};

function stateOf(row: {
	status: TurnState["status"];
	owner: string | null;
	cancelRequested: boolean;
	runs: number;
	mutationStarted: boolean;
	error: UserMessage | null;
	checkpointed: boolean;
}): TurnState {
	const facts = {
		owner: row.owner,
		cancelRequested: row.cancelRequested,
		runs: row.runs,
		checkpointed: row.checkpointed,
		mutationStarted: row.mutationStarted,
	};
	return row.status === "failed"
		? // `error` is nullable in the schema; a failed turn written without one
			// reads as having stopped unexpectedly.
			{ ...facts, status: "failed", userMessage: row.error ?? TURN_STOPPED_UNEXPECTEDLY }
		: { ...facts, status: row.status };
}

/** Locks the turn found by `condition`, and reads its state and thread. */
const lockedTurn = (condition: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({ ...stateColumns, threadId: turn.threadId })
				.from(turn)
				.where(condition)
				.limit(1)
				.for("update"),
		),
		([row]) => row && { id: row.id, threadId: row.threadId, state: stateOf(row) },
	);

function notRunnable(reason: string, ended?: Ended): NotRunnable {
	return { _tag: "NotRunnable", reason, ended };
}

/** How people are told a turn ended mid-run. */
function endAnnouncement(
	reply: {
		turnId: string;
		threadId: string;
		workspaceId: string;
		messageId: string;
		content: string;
	},
	ended: Ended,
): ConversationEvent {
	return ended.state === "failed"
		? ConversationEvent.TurnFailed({
				threadId: reply.threadId,
				workspaceId: reply.workspaceId,
				turnId: reply.turnId,
				messageId: reply.messageId,
				userMessage: ended.error,
				willRetry: false,
			})
		: ConversationEvent.TurnCancelled(reply);
}

/** The stored parts of a reply: its text, split around the collaborations and tool calls it made. */
function replyParts(reply: ReplyDraft): StoredMessagePart[] {
	if (!reply.content && reply.collaborations.length === 0 && reply.toolCalls.length === 0) {
		return [];
	}
	const placed: Array<
		Extract<StoredMessagePart, { type: "collaboration" | "tool_call" }> & { atOffset: number }
	> = [
		...reply.collaborations.map(({ id, atOffset }) => ({
			type: "collaboration" as const,
			collaborationId: id,
			atOffset,
		})),
		...reply.toolCalls.map(({ id, atOffset }) => ({
			type: "tool_call" as const,
			toolCallId: id,
			atOffset,
		})),
	];
	return messagePartsFor(reply.content, placed)
		.map((part): StoredMessagePart => {
			if (part.type === "text") return part;
			if (part.type === "collaboration")
				return { type: "collaboration", collaborationId: part.collaborationId };
			return { type: "tool_call", toolCallId: part.toolCallId };
		})
		.filter((part) => part.type !== "text" || part.text !== "");
}

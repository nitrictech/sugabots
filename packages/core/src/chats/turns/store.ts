export * as TurnStore from "./store.ts";

import { type FilePart, type Message, messagePartsFor } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import type { ModelMessage } from "ai";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import type { BlobStore } from "../../blob-store/blob-store.ts";
import {
	type Database,
	query,
	serviceOperations,
	type Transaction,
	transaction,
	writtenRow,
} from "../../database/database.ts";
import {
	ACTIVE_TURN_STATUSES,
	chat,
	message,
	messageReaction,
	type StoredMessagePart,
	type TurnReason,
	toolCall,
	turn,
} from "../../database/schema.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import type { UserFacing } from "../../user-message.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import {
	type ParticipantRow,
	reactionColumns,
	toMessage,
	toReactions,
} from "../store/participants.ts";
import {
	type Ended,
	endedAs,
	type FollowUp,
	RUN_ENDED,
	runsAgainAfterFailure,
	TURN_CANCELLED,
	TurnEvent,
	type TurnState,
	transition,
} from "./lifecycle.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import { WorkAdmission } from "./work-admission.ts";

/**
 * The only writer of `turn`, and of a turn's reply message while the turn
 * runs: what it says so far, and how it ended.
 *
 * Each command locks the turn, asks `lifecycle.ts` what the command makes of
 * it, writes that and emits it, in one transaction. A command the lifecycle
 * refuses writes nothing. Commands that end a turn's run also end its
 * unfinished tool calls, through `ToolCallStore`.
 *
 * A bot's turn writes a reply into its chat. A system bot's turn (the
 * Compaction bot compacting) writes something else
 * instead, so those have commands of their own and announce nothing.
 */
export interface Interface {
	/**
	 * Opens the turn a bot takes on a trigger message, with its reply: starts
	 * it, or reopens it for another run. A turn that may not run again says
	 * why, and how it ended if opening it ended it. An automation run that takes no
	 * more work (see `WorkAdmission`) opens no turn, and ends the one it
	 * finds.
	 */
	readonly openReplyTurn: (
		request: ReplyTurnRequest,
	) => Effect.Effect<OpenedReplyTurn | NotRunnable>;
	/** Opens a system bot's turn on the message it works up to, as `openReplyTurn` does. */
	readonly openSystemBotTurn: (
		request: SystemBotTurnRequest,
	) => Effect.Effect<OpenedSystemBotTurn | NotRunnable>;
	/** Persists the reply so far, so a crash loses at most a second of text. */
	readonly saveReply: (turn: ReplyTurn, draft: ReplyDraft) => Effect.Effect<void>;
	/**
	 * Attaches `file` to the turn's reply, after the files already on it, and
	 * announces what the reply carries now. Fails with `ReplyEnded` once the
	 * turn is no longer running, and `TooManyReplyFiles` once the reply
	 * carries as many as a message can.
	 */
	readonly attachFile: (
		turn: ReplyTurn,
		file: ReplyFile,
	) => Effect.Effect<
		FilePart,
		ReplyEnded | ChatFileStore.TooManyReplyFiles | ChatFileStore.FileTooLarge | BlobStore.Failure
	>;
	/** The files the turn's reply carries, in the order attached. */
	readonly replyFiles: (turn: ReplyTurn) => Effect.Effect<readonly FilePart[]>;
	/**
	 * Parks the turn with this model transcript until members decide the tool
	 * approvals it asked for. `false` when the turn is no longer running,
	 * was asked to stop, or its automation run takes no more turns.
	 */
	readonly suspend: (
		turn: ReplyTurn,
		checkpoint: TurnCheckpoint,
		approvals: readonly ToolCallStore.PendingToolApproval[],
	) => Effect.Effect<boolean>;
	readonly complete: (
		turn: ReplyTurn,
		draft: ReplyDraft,
		completion: TurnCompletion,
	) => Effect.Effect<void>;
	/**
	 * Records the run as failed, telling members `userMessage`, and returns
	 * whether the turn runs again: only if `mayRunAgain` and
	 * `runsAgainAfterFailure` both allow it.
	 */
	readonly fail: (
		turn: ReplyTurn,
		draft: ReplyDraft,
		failure: { userMessage: UserText; mayRunAgain: boolean },
	) => Effect.Effect<boolean>;
	/**
	 * Completes an optional turn whose bot chose not to answer: its empty
	 * reply is taken back, and the bot reacts 👀 to the message it read, so
	 * members see it was read.
	 */
	readonly staySilent: (turn: ReplyTurn, completion: TurnCompletion) => Effect.Effect<void>;
	/** Stops the run short, keeping the reply written so far. */
	readonly cancel: (turn: ReplyTurn, draft: ReplyDraft) => Effect.Effect<void>;
	readonly completeSystemBotTurn: (
		turnId: string,
		contextTokens: number | undefined,
	) => Effect.Effect<void>;
	readonly failSystemBotTurn: (turnId: string, userMessage: UserText) => Effect.Effect<void>;
	/** isInterruptRequested reports whether the turn was asked to stop, as when its automation run ended, or it is gone. */
	readonly isInterruptRequested: (turnId: string) => Effect.Effect<boolean>;
	/** Records a turn waiting for approvals as cancelled. Does nothing once it stopped waiting. */
	readonly cancelWaiting: (request: {
		botId: string;
		triggerMessageId: string;
	}) => Effect.Effect<void>;
	/**
	 * Ends the active turn the workflow execution `executionId` runs, which will not
	 * run it again. `undefined` if there is none.
	 */
	readonly abandon: (
		executionId: string,
		outcome: { status: "failed" | "cancelled"; userMessage: UserText },
	) => Effect.Effect<Ended | undefined>;
	/**
	 * Records that a write/delete tool call crossed its dispatch boundary, so the turn
	 * is not started again from here on, after a failure or after its server
	 * stopped without saying how the run ended. A fact the
	 * lifecycle reads rather than a transition, so it takes no lock.
	 */
	readonly markActed: (turnId: string) => Effect.Effect<void>;
	/**
	 * Cancels the turns waiting in these chats, and asks the running ones to
	 * stop, because the automation run they work for ended. A running turn another
	 * transaction holds is skipped: its workflow is recording how it ended.
	 * Returns the workflow executions of the waiting turns it cancelled, which
	 * are still waiting and have to be told.
	 */
	readonly cancelUnder: (chatIds: readonly string[]) => Effect.Effect<readonly string[]>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnStore") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnStore");
	const { emit } = yield* ChatEvents.Service;
	const admission = yield* WorkAdmission.Service;
	const toolCalls = yield* ToolCallStore.Service;
	const files = yield* ChatFileStore.Service;

	/**
	 * Writes the state the lifecycle decided, plus what else the command
	 * records, and answers the time it wrote it at: when the turn finished, if
	 * `next` ends it. Only failing records the turn as `retrying`.
	 */
	const write = (
		turnId: string,
		next: TurnState,
		recorded: Partial<
			Pick<typeof turn.$inferInsert, "checkpoint" | "retrying" | keyof ContextMeasurement>
		> = {},
	) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			yield* query((db) =>
				db
					.update(turn)
					.set({
						status: next.status,
						executionId: next.executionId,
						interruptRequested: next.interruptRequested,
						runs: next.runs,
						error: next.status === "failed" ? next.userMessage : null,
						finishedAt: next.status === "running" || next.status === "waiting" ? null : now,
						retrying: false,
						...(next.checkpointed ? {} : { checkpoint: null }),
						...recorded,
					})
					.where(eq(turn.id, turnId)),
			);
			return now;
		});

	/**
	 * Ends the reply and the unfinished tool calls of a turn the lifecycle
	 * ended mid-run, telling members `userMessage` of the calls, and announces
	 * how it ended. A system bot's turn has no reply, so there is nothing to
	 * announce.
	 */
	const endRun = (turnId: string, state: TurnState, userMessage: UserText, finishedAt: Date) =>
		Effect.gen(function* () {
			const ended = endedAs(state);
			const [reply] = yield* query((db) =>
				db
					.select({
						messageId: message.id,
						content: message.content,
						chatId: turn.chatId,
						botId: turn.botId,
						workspaceId: chat.workspaceId,
					})
					.from(message)
					.innerJoin(turn, eq(turn.id, message.turnId))
					.innerJoin(chat, eq(chat.id, turn.chatId))
					.where(eq(message.turnId, turnId))
					.limit(1),
			);
			if (reply) {
				yield* query((db) =>
					db.update(message).set({ status: ended.state }).where(eq(message.id, reply.messageId)),
				);
			}
			yield* toolCalls.abandonUnfinished([turnId], userMessage);
			if (reply) {
				yield* emit([endAnnouncement({ turnId, finishedAt, ...reply }, ended)]);
			}
			return ended;
		});

	/** Locks the turn found by `condition` and asks the lifecycle what `event` makes of it. */
	const lockAndTransition = (condition: SQL | undefined, event: TurnEvent) =>
		Effect.map(lockedTurn(condition), (locked) =>
			locked
				? {
						id: locked.id,
						botId: locked.botId,
						state: locked.state,
						decided: transition(locked.state, event),
					}
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
		executionId: string | null,
	): Effect.Effect<
		{ _tag: "Reopened"; followUp: FollowUp | undefined } | NotRunnable,
		never,
		Database | Transaction
	> =>
		Effect.gen(function* () {
			const [uncertainWriteOrDelete] = yield* query((db) =>
				db
					.select({ id: toolCall.id })
					.from(toolCall)
					.where(
						and(
							eq(toolCall.turnId, existing.id),
							eq(toolCall.status, "running"),
							eq(toolCall.writeOrDelete, true),
						),
					)
					.limit(1),
			);
			const decided = transition(
				existing.state,
				TurnEvent.Reopen({
					executionId,
					uncertainWriteOrDelete: uncertainWriteOrDelete !== undefined,
				}),
			);
			if (decided._tag === "Refused") return notRunnable(decided.reason);
			const writtenAt = yield* write(existing.id, decided.state);
			if (decided.followUp?._tag !== "End") {
				return { _tag: "Reopened", followUp: decided.followUp };
			}
			const ended = yield* endRun(
				existing.id,
				decided.state,
				decided.followUp.userMessage,
				writtenAt,
			);
			return notRunnable(decided.followUp.userMessage, ended);
		});

	const insertTurn = (
		request: SystemBotTurnRequest & Partial<Pick<ReplyTurnRequest, "reason" | "executionId">>,
	) =>
		Effect.gen(function* () {
			const startedAt = yield* DateTime.nowAsDate;
			const created = yield* query((db) =>
				db
					.insert(turn)
					.values({
						chatId: request.chatId,
						botId: request.botId,
						triggerMessageId: request.triggerMessageId,
						executionId: request.executionId ?? null,
						runs: 1,
						status: "running",
						reason: request.reason,
						model: request.model,
						startedAt,
					})
					.returning({ id: turn.id }),
			).pipe(Effect.flatMap(writtenRow("turn")));
			return created.id;
		});

	/** Ends `existing`, if it is still active, because its automation run takes no more work. */
	const endForEndedAutomation = (existing: { id: string; state: TurnState } | undefined) =>
		Effect.gen(function* () {
			const reason = "The automation run has ended";
			const decided =
				existing &&
				transition(
					existing.state,
					TurnEvent.Abandon({ status: "cancelled", userMessage: RUN_ENDED }),
				);
			if (!existing || decided?._tag !== "Next") return notRunnable(reason);
			const writtenAt = yield* write(existing.id, decided.state);
			return notRunnable(reason, yield* endRun(existing.id, decided.state, RUN_ENDED, writtenAt));
		});

	const announceStart = (request: ReplyTurnRequest, turnId: string, reply: Message) =>
		Effect.gen(function* () {
			const [started] = yield* query((db) =>
				db
					.select({ workspaceId: chat.workspaceId })
					.from(chat)
					.where(eq(chat.id, request.chatId))
					.limit(1),
			);
			if (!started) return yield* Effect.die(new Error("A turn's chat is gone"));
			yield* emit([
				ChatEvent.TurnStarted({
					chatId: request.chatId,
					workspaceId: started.workspaceId,
					turnId,
					botId: request.botId,
					reply,
				}),
			]);
		});

	return Service.of({
		openReplyTurn: (request) =>
			operation(
				"openReplyTurn",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						OpenedReplyTurn | NotRunnable,
						never,
						Database | Transaction
					> {
						const acceptsWork = yield* admission.admits(request.chatId);
						const existing = yield* lockedTurn(onTrigger(request));
						if (!acceptsWork) return yield* endForEndedAutomation(existing);
						if (!existing) {
							const replyValues = {
								chatId: request.chatId,
								authorBotId: request.botId,
								status: "writing" as const,
								parts: [],
								content: "",
							};
							// An interview starts with the reply itself, so it has to exist
							// before the turn can reference it as its trigger.
							if (request.reason === "interview") {
								yield* query((db) =>
									db.insert(message).values({ ...replyValues, id: request.triggerMessageId }),
								);
							}
							const turnId = yield* insertTurn(request);
							const created = yield* query((db) =>
								request.reason === "interview"
									? db
											.update(message)
											.set({ turnId })
											.where(eq(message.id, request.triggerMessageId))
											.returning()
									: db
											.insert(message)
											.values({ ...replyValues, turnId })
											.returning(),
							).pipe(Effect.flatMap(writtenRow("message")));
							const reply = toMessage(created, request.author);
							yield* announceStart(request, turnId, reply);
							return { _tag: "Opened", turnId, reply, checkpoint: undefined };
						}
						const reopened = yield* reopen(existing, request.executionId);
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
						const [retried] = yield* query((db) =>
							db
								.update(message)
								.set({ status: "writing", parts: [], content: "" })
								.where(eq(message.turnId, existing.id))
								.returning(),
						);
						if (!retried) {
							return yield* Effect.die(new Error("A turn being run again has no reply message"));
						}
						// The reply starts again, so the calls its last run made go with its
						// parts, and the files it attached with them.
						yield* toolCalls.forgetReply(retried.id);
						yield* files.removeReplyAttachments({
							chatId: retried.chatId,
							messageId: retried.id,
						});
						const reply = toMessage(retried, request.author);
						yield* announceStart(request, existing.id, reply);
						return { _tag: "Opened", turnId: existing.id, reply, checkpoint: undefined };
					}),
				),
			),

		openSystemBotTurn: (request) =>
			operation(
				"openSystemBotTurn",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						OpenedSystemBotTurn | NotRunnable,
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
			),

		saveReply: (reply, draft) => operation("saveReply", Effect.asVoid(writeReply(reply, draft))),
		attachFile: (reply, file) =>
			operation(
				"attachFile",
				files.withReplyFile(
					{ chatId: reply.chatId, messageId: reply.messageId, ...file },
					(stored) =>
						transaction(
							Effect.gen(function* () {
								// Locked, as ending the turn locks it: a call still running when the
								// turn was cancelled finds it ended, and shares nothing.
								const [running] = yield* query((db) =>
									db
										.select({ id: turn.id })
										.from(turn)
										.where(and(eq(turn.id, reply.turnId), eq(turn.status, "running")))
										.for("update"),
								);
								if (!running) return yield* new ReplyEnded();
								const attached = yield* files.attachToReply(stored);
								const carried = yield* files.replyAttachments(reply.messageId);
								yield* emit([
									ChatEvent.MessageFilesChanged({
										chatId: reply.chatId,
										messageId: reply.messageId,
										files: carried,
									}),
								]);
								return attached;
							}),
						),
				),
			),
		replyFiles: (reply) => operation("replyFiles", files.replyAttachments(reply.messageId)),

		suspend: (reply, checkpoint, approvals) =>
			operation(
				"suspend",
				transaction(
					Effect.gen(function* () {
						if (!(yield* admission.admits(reply.chatId))) return false;
						const locked = yield* lockAndTransition(eq(turn.id, reply.turnId), TurnEvent.Suspend());
						if (locked?.decided._tag !== "Next") return false;
						yield* write(locked.id, locked.decided.state, { checkpoint });
						yield* toolCalls.requestApprovals(
							{
								chatId: reply.chatId,
								messageId: reply.messageId,
								turnId: locked.id,
							},
							approvals,
						);
						yield* writeReply(reply, checkpoint.reply);
						yield* emit([
							ChatEvent.TurnSuspended({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
							}),
						]);
						return true;
					}),
				),
			),

		staySilent: (reply, completion) =>
			operation(
				"staySilent",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(
							eq(turn.id, reply.turnId),
							TurnEvent.Complete(),
						);
						if (locked?.decided._tag !== "Next") return;
						yield* write(locked.id, locked.decided.state, measurementColumns(completion));
						yield* query((db) => db.delete(message).where(eq(message.id, reply.messageId)));
						const [read] = yield* query((db) =>
							db
								.select({ messageId: turn.triggerMessageId })
								.from(turn)
								.where(eq(turn.id, locked.id)),
						);
						if (!read) return yield* Effect.die(new Error("A turn being completed is gone"));
						yield* query((db) =>
							db
								.insert(messageReaction)
								.values({ messageId: read.messageId, botId: reply.botId, emoji: SEEN_EMOJI })
								.onConflictDoNothing(),
						);
						const reactions = yield* query((db) =>
							db.query.messageReaction.findMany({
								where: { messageId: read.messageId },
								...reactionColumns,
							}),
						);
						yield* emit([
							ChatEvent.TurnStayedSilent({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
							}),
							ChatEvent.ReactionsChanged({
								chatId: reply.chatId,
								messageId: read.messageId,
								reactions: toReactions(reactions),
							}),
						]);
					}),
				),
			),

		complete: (reply, draft, completion) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(
							eq(turn.id, reply.turnId),
							TurnEvent.Complete(),
						);
						if (locked?.decided._tag !== "Next") return;
						yield* writeReply(reply, draft, "complete");
						const finishedAt = yield* write(
							locked.id,
							locked.decided.state,
							measurementColumns(completion),
						);
						yield* emit([
							ChatEvent.TurnCompleted({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: reply.botId,
								messageId: reply.messageId,
								content: draft.content,
								finishedAt,
								contextTokens: completion.contextTokens,
								contextCapacity: completion.contextCapacity,
								readKeptFrom: completion.readKeptFrom,
							}),
						]);
					}),
				),
			),

		fail: (reply, draft, { userMessage, mayRunAgain }) =>
			operation(
				"fail",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(
							eq(turn.id, reply.turnId),
							TurnEvent.Fail({ userMessage }),
						);
						if (locked?.decided._tag !== "Next") return false;
						const willRetry = mayRunAgain && runsAgainAfterFailure(locked.state);
						yield* writeReply(reply, draft, "failed");
						yield* write(locked.id, locked.decided.state, { retrying: willRetry });
						yield* toolCalls.abandonUnfinished([locked.id], userMessage);
						yield* emit([
							ChatEvent.TurnFailed({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: locked.botId,
								messageId: reply.messageId,
								userMessage,
								willRetry,
							}),
						]);
						return willRetry;
					}),
				),
			),

		cancel: (reply, draft) =>
			operation(
				"cancel",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(eq(turn.id, reply.turnId), TurnEvent.Cancel());
						if (locked?.decided._tag !== "Next") return;
						yield* writeReply(reply, draft, "cancelled");
						const finishedAt = yield* write(locked.id, locked.decided.state);
						yield* toolCalls.abandonUnfinished([locked.id], TURN_CANCELLED);
						yield* emit([
							ChatEvent.TurnInterrupted({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: locked.botId,
								messageId: reply.messageId,
								content: draft.content,
								finishedAt,
							}),
						]);
					}),
				),
			),

		completeSystemBotTurn: (turnId, contextTokens) =>
			operation(
				"completeSystemBotTurn",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(eq(turn.id, turnId), TurnEvent.Complete());
						if (locked?.decided._tag !== "Next") return;
						yield* write(locked.id, locked.decided.state, measurementColumns({ contextTokens }));
					}),
				),
			),

		failSystemBotTurn: (turnId, userMessage) =>
			operation(
				"failSystemBotTurn",
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
			),

		isInterruptRequested: (turnId) =>
			operation(
				"isInterruptRequested",
				Effect.map(
					query((db) =>
						db
							.select({ requested: turn.interruptRequested })
							.from(turn)
							.where(eq(turn.id, turnId))
							.limit(1),
					),
					// A turn that has vanished should stop too.
					([row]) => row?.requested ?? true,
				),
			),

		cancelWaiting: (request) =>
			operation(
				"cancelWaiting",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(onTrigger(request), TurnEvent.CancelWaiting());
						if (locked?.decided._tag !== "Next") return;
						const writtenAt = yield* write(locked.id, locked.decided.state);
						if (locked.decided.followUp?._tag === "End") {
							yield* endRun(
								locked.id,
								locked.decided.state,
								locked.decided.followUp.userMessage,
								writtenAt,
							);
						}
					}),
				),
			),

		abandon: (executionId, outcome) =>
			operation(
				"abandon",
				transaction(
					Effect.gen(function* () {
						const owned = and(
							eq(turn.executionId, executionId),
							inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
						);
						const locked = yield* lockAndTransition(owned, TurnEvent.Abandon(outcome));
						if (locked?.decided._tag !== "Next") return undefined;
						const writtenAt = yield* write(locked.id, locked.decided.state);
						return yield* endRun(locked.id, locked.decided.state, outcome.userMessage, writtenAt);
					}),
				),
			),

		markActed: (turnId) =>
			operation(
				"markActed",
				query((db) =>
					db.update(turn).set({ writeOrDeleteStarted: true }).where(eq(turn.id, turnId)),
				).pipe(Effect.asVoid),
			),

		cancelUnder: (chatIds) =>
			operation(
				"cancelUnder",
				transaction(
					Effect.gen(function* () {
						if (chatIds.length === 0) return [];
						const under = inArray(turn.chatId, [...chatIds]);
						// Settlement runs in a transaction of its own, after its trigger
						// commits, so whoever holds a waiting turn is not waiting on it.
						const waiting = yield* query((db) =>
							db
								.select({ ...stateColumns, chatId: turn.chatId })
								.from(turn)
								.where(and(under, eq(turn.status, "waiting")))
								.for("update"),
						);
						const running = yield* query((db) =>
							db
								.select({ ...stateColumns, chatId: turn.chatId })
								.from(turn)
								.where(and(under, eq(turn.status, "running")))
								.for("update", { skipLocked: true }),
						);
						const executionsToTell = yield* Effect.forEach([...waiting, ...running], (row) =>
							Effect.gen(function* () {
								const decided = transition(stateOf(row), TurnEvent.AutomationEnded());
								if (decided._tag === "Refused") return [];
								const writtenAt = yield* write(row.id, decided.state);
								if (decided.followUp?._tag === "AnnounceCancelRequest") {
									yield* emit([
										ChatEvent.TurnInterruptRequested({
											chatId: row.chatId,
											turnId: row.id,
										}),
									]);
								}
								if (decided.followUp?._tag !== "End") return [];
								yield* endRun(row.id, decided.state, decided.followUp.userMessage, writtenAt);
								return row.executionId ? [row.executionId] : [];
							}),
						);
						return executionsToTell.flat();
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/** Ending a turn ends its tool calls, and retrying a reply removes the files it attached. */
export const layer = layerNoDeps.pipe(Layer.provide([ToolCallStore.layer, ChatFileStore.layer]));

/** A file a bot attaches to its reply: its name, media type and bytes. */
interface ReplyFile {
	readonly name: string;
	readonly contentType: string;
	readonly content: Uint8Array;
}

/** A file was shared to a reply after its turn had ended, as when it was cancelled. */
export class ReplyEnded extends Data.TaggedError("ReplyEnded") implements UserFacing {
	override get message() {
		return "A file was shared to a reply whose turn had ended";
	}
	get userMessage() {
		return userText`The reply has ended, so the file wasn't shared`;
	}
}

/** Where a bot's turn is: its chat and workspace, and the reply it writes. */
export interface ReplyTurn {
	readonly turnId: string;
	readonly chatId: string;
	readonly workspaceId: string;
	readonly botId: string;
	readonly messageId: string;
}

interface ReplyTurnRequest {
	readonly chatId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
	/** The bot's model, already resolved: a turn is never opened without one. */
	readonly model: string;
	readonly reason: TurnReason;
	/** The workflow execution running the turn. */
	readonly executionId: string;
	/** Who the reply is shown as. */
	readonly author: ParticipantRow;
}

interface SystemBotTurnRequest {
	readonly chatId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
	readonly model: string;
}

interface OpenedReplyTurn {
	readonly _tag: "Opened";
	readonly turnId: string;
	/** The reply, `writing`. */
	readonly reply: Message;
	/** Where a suspended turn left off; set only when this run continues it. */
	readonly checkpoint: TurnCheckpoint | undefined;
}

interface OpenedSystemBotTurn {
	readonly _tag: "Opened";
	readonly turnId: string;
}

/** A turn that may not run. `reason` is for the logs; `ended` is set when opening it ended it. */
export interface NotRunnable {
	readonly _tag: "NotRunnable";
	readonly reason: string;
	readonly ended: Ended | undefined;
}

const PlacedPart = Schema.Struct({ id: Schema.String, atOffset: Schema.Int });

/**
 * The reply as the segment has it so far: the text, and where in that text the
 * bot made each tool call. Stored as parts in that order.
 */
export const ReplyDraft = Schema.Struct({
	content: Schema.String,
	toolCalls: Schema.Array(PlacedPart),
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

/** What an approved call must still match when it runs (see `ToolCallStore.ApprovalBinding`). */
const ApprovalBinding = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("connector"),
		connectorId: Schema.String,
		connectorRevision: Schema.Int,
		remoteToolName: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("built-in") }),
]);

/** A call the suspended turn waits on, and what it must still match to run. */
const CheckpointApproval = Schema.Struct({
	approvalId: Schema.String,
	tool: Schema.String,
	binding: ApprovalBinding,
});

/** Everything a suspended turn needs to continue once its approvals are decided. */
export const TurnCheckpoint = Schema.Struct({
	messages: Schema.Array(SdkModelMessage),
	approvals: Schema.Array(CheckpointApproval),
	modelInput: Schema.Struct({
		model: Schema.String,
		system: Schema.String,
		messages: Schema.Array(
			Schema.Struct({
				role: Schema.Literals(["user", "assistant"]),
				content: Schema.String,
				cacheBreakpoint: Schema.optional(Schema.Literal(true)),
			}),
		),
	}),
	reply: ReplyDraft,
	/** The model requests made before the turn suspended, which cap the steps a resumed segment has left. */
	modelRequests: Schema.Int,
	/** The prompt's size at the turn's first model request, which a resumed segment keeps. */
	contextTokens: Schema.optional(Schema.Int),
});
export type TurnCheckpoint = typeof TurnCheckpoint.Type;

/** How much of its model's context window a turn's prompt took. */
interface ContextMeasurement {
	contextTokens?: number;
	/** The window the prompt was read with. */
	contextCapacity?: number;
}

/** What a bot reacts with to a message it read on an optional turn and chose not to answer. */
const SEEN_EMOJI = "👀";

/** How a reply completed, for what reacts to it (see `TurnCompleted`). */
interface TurnCompletion extends ContextMeasurement {
	/** A reply is always read with a window. */
	readonly contextCapacity: number;
	readonly readKeptFrom: string | null;
}

function measurementColumns(measured: ContextMeasurement) {
	return {
		contextTokens: measured.contextTokens ?? null,
		contextCapacity: measured.contextCapacity ?? null,
	};
}

/** The turn a bot takes on a trigger message: there is at most one. */
function onTrigger(request: { botId: string; triggerMessageId: string }) {
	return and(eq(turn.triggerMessageId, request.triggerMessageId), eq(turn.botId, request.botId));
}

/** What the lifecycle needs to know of a turn, and its id. */
const stateColumns = {
	id: turn.id,
	status: turn.status,
	executionId: turn.executionId,
	interruptRequested: turn.interruptRequested,
	runs: turn.runs,
	writeOrDeleteStarted: turn.writeOrDeleteStarted,
	error: turn.error,
	checkpointed: sql<boolean>`${turn.checkpoint} is not null`,
};

function stateOf(row: {
	status: TurnState["status"];
	executionId: string | null;
	interruptRequested: boolean;
	runs: number;
	writeOrDeleteStarted: boolean;
	error: UserText | null;
	checkpointed: boolean;
}): TurnState {
	const facts = {
		executionId: row.executionId,
		interruptRequested: row.interruptRequested,
		runs: row.runs,
		checkpointed: row.checkpointed,
		writeOrDeleteStarted: row.writeOrDeleteStarted,
	};
	if (row.status !== "failed") return { ...facts, status: row.status };
	if (row.error === null) throw new Error("A failed turn has no error, which the schema forbids");
	return { ...facts, status: "failed", userMessage: row.error };
}

/** Locks the turn found by `condition`, and reads its state and bot. */
const lockedTurn = (condition: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({ ...stateColumns, botId: turn.botId })
				.from(turn)
				.where(condition)
				.limit(1)
				.for("update"),
		),
		([row]) =>
			row && {
				id: row.id,
				botId: row.botId,
				state: stateOf(row),
			},
	);

export function notRunnable(reason: string, ended?: Ended): NotRunnable {
	return { _tag: "NotRunnable", reason, ended };
}

/** How members are told a turn ended mid-run. */
function endAnnouncement(
	reply: {
		turnId: string;
		chatId: string;
		workspaceId: string;
		botId: string;
		messageId: string;
		content: string;
		finishedAt: Date;
	},
	ended: Ended,
): ChatEvent {
	return ended.state === "failed"
		? ChatEvent.TurnFailed({
				chatId: reply.chatId,
				workspaceId: reply.workspaceId,
				turnId: reply.turnId,
				botId: reply.botId,
				messageId: reply.messageId,
				userMessage: ended.error,
				willRetry: false,
			})
		: ChatEvent.TurnInterrupted(reply);
}

/** The stored parts of a reply: its text, split around the tool calls it made. */
function replyParts(reply: ReplyDraft): StoredMessagePart[] {
	if (!reply.content && reply.toolCalls.length === 0) {
		return [];
	}
	const placed = reply.toolCalls.map(({ id, atOffset }) => ({
		type: "tool_call" as const,
		toolCallId: id,
		atOffset,
	}));
	return messagePartsFor(reply.content, placed)
		.map(
			(part): StoredMessagePart =>
				part.type === "text" ? part : { type: "tool_call", toolCallId: part.toolCallId },
		)
		.filter((part) => part.type !== "text" || part.text !== "");
}

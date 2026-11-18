export * as TurnRepository from "./repository.ts";

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
	conversation,
	message,
	type StoredMessagePart,
	type TurnReason,
	toolCall,
	turn,
} from "../../database/schema.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import type { UserFacing } from "../../user-message.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { type ParticipantRow, toMessage } from "../repository/participants.ts";
import {
	type Ended,
	endedAs,
	type FollowUp,
	RUN_ENDED,
	runsAgainAfterFailure,
	TURN_CANCELLED,
	TURN_STOPPED_UNEXPECTEDLY,
	TurnEvent,
	type TurnState,
	transition,
} from "./lifecycle.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import { WorkAdmission } from "./work-admission.ts";

/**
 * The only writer of `turn`, and of a turn's reply message while the turn
 * runs: what it says so far, and how it ended.
 *
 * Each command locks the turn, asks `lifecycle.ts` what the command makes of
 * it, writes that and emits it, in one transaction. A command the lifecycle
 * refuses writes nothing. Commands that end a turn's run also end its
 * unfinished tool calls, through `ToolCallRepository`.
 *
 * A bot's turn writes a reply into its conversation. A system bot's turn (the
 * Summariser summarising, the Compaction bot compacting) writes something else
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
		| ReplyEnded
		| ConversationFiles.TooManyReplyFiles
		| ConversationFiles.FileTooLarge
		| BlobStore.Failure
	>;
	/** The files the turn's reply carries, in the order attached. */
	readonly replyFiles: (turn: ReplyTurn) => Effect.Effect<readonly FilePart[]>;
	/**
	 * Parks the turn with this model transcript until people decide the tool
	 * approvals it asked for. `false` when the turn is no longer running,
	 * somebody asked it to stop, or its automation run takes no more turns.
	 */
	readonly suspend: (
		turn: ReplyTurn,
		checkpoint: TurnCheckpoint,
		approvals: readonly ToolCallRepository.PendingToolApproval[],
	) => Effect.Effect<boolean>;
	readonly complete: (
		turn: ReplyTurn,
		draft: ReplyDraft,
		completion: TurnCompletion,
	) => Effect.Effect<void>;
	/**
	 * Records the run as failed, telling people `userMessage`, and returns
	 * whether the turn runs again: only if `mayRunAgain` and
	 * `runsAgainAfterFailure` both allow it.
	 */
	readonly fail: (
		turn: ReplyTurn,
		draft: ReplyDraft,
		failure: { userMessage: UserText; mayRunAgain: boolean },
	) => Effect.Effect<boolean>;
	/** Stops the run short, keeping the reply written so far. */
	readonly cancel: (turn: ReplyTurn, draft: ReplyDraft) => Effect.Effect<void>;
	readonly completeSystemBotTurn: (
		turnId: string,
		contextTokens: number | undefined,
	) => Effect.Effect<void>;
	readonly failSystemBotTurn: (turnId: string, userMessage: UserText) => Effect.Effect<void>;
	/** Asks the turn to stop, and says who has to be told. */
	readonly requestCancel: (turnId: string) => Effect.Effect<CancelRequest>;
	/** isCancellationRequested reports whether somebody asked the turn to stop, or it is gone. */
	readonly isCancellationRequested: (turnId: string) => Effect.Effect<boolean>;
	/** Records a turn waiting for approvals as cancelled. Does nothing once it stopped waiting. */
	readonly cancelWaiting: (request: {
		botId: string;
		triggerMessageId: string;
	}) => Effect.Effect<void>;
	/**
	 * Ends the active turn the workflow execution `owner` runs, which will not
	 * run it again. `undefined` if there is none.
	 */
	readonly abandon: (
		owner: string,
		outcome: { status: "failed" | "cancelled"; userMessage: UserText },
	) => Effect.Effect<Ended | undefined>;
	/**
	 * Records that a mutating tool crossed its dispatch boundary, so the turn
	 * is not started again from here on, after a failure or after its server
	 * stopped without saying how the run ended. A fact the
	 * lifecycle reads rather than a transition, so it takes no lock.
	 */
	readonly markActed: (turnId: string) => Effect.Effect<void>;
	/**
	 * Cancels the turns waiting in these conversations, and asks the running ones to
	 * stop, because the automation run they work for ended. A running turn another
	 * transaction holds is skipped: its workflow is recording how it ended.
	 * Returns the workflow executions of the waiting turns it cancelled, which
	 * are still waiting and have to be told.
	 */
	readonly cancelUnder: (conversationIds: readonly string[]) => Effect.Effect<readonly string[]>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/TurnRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnRepository");
	const { emit } = yield* ConversationEvents.Service;
	const admission = yield* WorkAdmission.Service;
	const toolCalls = yield* ToolCallRepository.Service;
	const files = yield* ConversationFiles.Service;

	/** Writes the state the lifecycle decided, plus what else the command records. */
	const write = (
		turnId: string,
		next: TurnState,
		recorded: Partial<Pick<typeof turn.$inferInsert, "checkpoint" | keyof ContextMeasurement>> = {},
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
	 * how it ended. A system bot's turn has no reply, so there is nothing to
	 * announce.
	 */
	const endRun = (turnId: string, state: TurnState, userMessage: UserText) =>
		Effect.gen(function* () {
			const ended = endedAs(state);
			const [reply] = yield* query((db) =>
				db
					.select({
						messageId: message.id,
						content: message.content,
						conversationId: turn.conversationId,
						botId: turn.botId,
						workspaceId: conversation.workspaceId,
					})
					.from(message)
					.innerJoin(turn, eq(turn.id, message.turnId))
					.innerJoin(conversation, eq(conversation.id, turn.conversationId))
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
				yield* emit([endAnnouncement({ turnId, ...reply }, ended)]);
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
		request: SystemBotTurnRequest & Partial<Pick<ReplyTurnRequest, "reason" | "owner">>,
	) =>
		Effect.gen(function* () {
			const startedAt = yield* DateTime.nowAsDate;
			const created = yield* query((db) =>
				db
					.insert(turn)
					.values({
						conversationId: request.conversationId,
						botId: request.botId,
						triggerMessageId: request.triggerMessageId,
						owner: request.owner ?? null,
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
			yield* write(existing.id, decided.state);
			return notRunnable(reason, yield* endRun(existing.id, decided.state, RUN_ENDED));
		});

	const announceStart = (request: ReplyTurnRequest, turnId: string, reply: Message) =>
		emit([
			ConversationEvent.TurnStarted({
				conversationId: request.conversationId,
				turnId,
				botId: request.botId,
				reply,
			}),
		]);

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
						const acceptsWork = yield* admission.admits(request.conversationId);
						const existing = yield* lockedTurn(onTrigger(request));
						if (!acceptsWork) return yield* endForEndedAutomation(existing);
						if (!existing) {
							const replyValues = {
								conversationId: request.conversationId,
								authorBotId: request.botId,
								kind: "text" as const,
								status: "streaming" as const,
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
						// The reply starts again, so the calls its last run made go with its
						// parts, and the files it attached with them.
						yield* toolCalls.forgetReply(restarted.id);
						yield* files.removeReplyAttachments({
							conversationId: restarted.conversationId,
							messageId: restarted.id,
						});
						const reply = toMessage(restarted, request.author);
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
					{ conversationId: reply.conversationId, messageId: reply.messageId, ...file },
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
									ConversationEvent.MessageFilesChanged({
										conversationId: reply.conversationId,
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
						if (!(yield* admission.admits(reply.conversationId))) return false;
						const locked = yield* lockAndTransition(eq(turn.id, reply.turnId), TurnEvent.Suspend());
						if (locked?.decided._tag !== "Next") return false;
						yield* write(locked.id, locked.decided.state, { checkpoint });
						yield* toolCalls.requestApprovals(
							{
								conversationId: reply.conversationId,
								messageId: reply.messageId,
								turnId: locked.id,
							},
							approvals,
						);
						yield* writeReply(reply, checkpoint.reply);
						yield* emit([
							ConversationEvent.TurnSuspended({
								conversationId: reply.conversationId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
							}),
						]);
						return true;
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
						yield* write(locked.id, locked.decided.state, measurementColumns(completion));
						yield* emit([
							ConversationEvent.TurnCompleted({
								conversationId: reply.conversationId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: reply.botId,
								messageId: reply.messageId,
								content: draft.content,
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
						yield* write(locked.id, locked.decided.state);
						yield* toolCalls.abandonUnfinished([locked.id], userMessage);
						yield* emit([
							ConversationEvent.TurnFailed({
								conversationId: reply.conversationId,
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
						yield* write(locked.id, locked.decided.state);
						yield* toolCalls.abandonUnfinished([locked.id], TURN_CANCELLED);
						yield* emit([
							ConversationEvent.TurnCancelled({
								conversationId: reply.conversationId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: locked.botId,
								messageId: reply.messageId,
								content: draft.content,
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

		requestCancel: (turnId) =>
			operation(
				"requestCancel",
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
						// The turn's workflow stops on this event; it reads the flag only as a fallback.
						yield* emit([
							ConversationEvent.TurnCancelRequested({
								conversationId: locked.conversationId,
								turnId,
							}),
						]);
						return { _tag: "Announced" };
					}),
				),
			),

		isCancellationRequested: (turnId) =>
			operation(
				"isCancellationRequested",
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
			),

		cancelWaiting: (request) =>
			operation(
				"cancelWaiting",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockAndTransition(onTrigger(request), TurnEvent.CancelWaiting());
						if (locked?.decided._tag !== "Next") return;
						yield* write(locked.id, locked.decided.state);
						if (locked.decided.followUp?._tag === "End") {
							yield* endRun(locked.id, locked.decided.state, locked.decided.followUp.userMessage);
						}
					}),
				),
			),

		abandon: (owner, outcome) =>
			operation(
				"abandon",
				transaction(
					Effect.gen(function* () {
						const owned = and(
							eq(turn.owner, owner),
							inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
						);
						const locked = yield* lockAndTransition(owned, TurnEvent.Abandon(outcome));
						if (locked?.decided._tag !== "Next") return undefined;
						yield* write(locked.id, locked.decided.state);
						return yield* endRun(locked.id, locked.decided.state, outcome.userMessage);
					}),
				),
			),

		markActed: (turnId) =>
			operation(
				"markActed",
				query((db) =>
					db.update(turn).set({ mutationStarted: true }).where(eq(turn.id, turnId)),
				).pipe(Effect.asVoid),
			),

		cancelUnder: (conversationIds) =>
			operation(
				"cancelUnder",
				transaction(
					Effect.gen(function* () {
						if (conversationIds.length === 0) return [];
						const under = inArray(turn.conversationId, [...conversationIds]);
						// Settlement runs in a transaction of its own, after its trigger
						// commits, so whoever holds a waiting turn is not waiting on it.
						const waiting = yield* query((db) =>
							db
								.select({ ...stateColumns, conversationId: turn.conversationId })
								.from(turn)
								.where(and(under, eq(turn.status, "waiting")))
								.for("update"),
						);
						const running = yield* query((db) =>
							db
								.select({ ...stateColumns, conversationId: turn.conversationId })
								.from(turn)
								.where(and(under, eq(turn.status, "running")))
								.for("update", { skipLocked: true }),
						);
						const ownersToTell = yield* Effect.forEach([...waiting, ...running], (row) =>
							Effect.gen(function* () {
								const decided = transition(stateOf(row), TurnEvent.AutomationEnded());
								if (decided._tag === "Refused") return [];
								yield* write(row.id, decided.state);
								if (decided.followUp?._tag === "AnnounceCancelRequest") {
									yield* emit([
										ConversationEvent.TurnCancelRequested({
											conversationId: row.conversationId,
											turnId: row.id,
										}),
									]);
								}
								if (decided.followUp?._tag !== "End") return [];
								yield* endRun(row.id, decided.state, decided.followUp.userMessage);
								return row.owner ? [row.owner] : [];
							}),
						);
						return ownersToTell.flat();
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/** Ending a turn ends its tool calls, and restarting a reply removes the files it attached. */
export const layer = layerNoDeps.pipe(
	Layer.provide([ToolCallRepository.layer, ConversationFiles.layer]),
);

/** A file a bot attaches to its reply: its name, media type and bytes. */
export interface ReplyFile {
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

/** Where a bot's turn is: its conversation and workspace, and the reply it writes. */
export interface ReplyTurn {
	readonly turnId: string;
	readonly conversationId: string;
	readonly workspaceId: string;
	readonly botId: string;
	readonly reason: TurnReason | undefined;
	readonly messageId: string;
}

interface ReplyTurnRequest {
	readonly conversationId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
	/** The bot's model, already resolved: a turn is never opened without one. */
	readonly model: string;
	readonly reason: TurnReason | undefined;
	/** The workflow execution running the turn. */
	readonly owner: string;
	/** Who the reply is shown as. */
	readonly author: ParticipantRow;
}

interface SystemBotTurnRequest {
	readonly conversationId: string;
	readonly botId: string;
	readonly triggerMessageId: string;
	readonly model: string;
}

interface OpenedReplyTurn {
	readonly _tag: "Opened";
	readonly turnId: string;
	/** The reply, `streaming`. */
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

type CancelRequest =
	| { readonly _tag: "SignalOwner"; readonly owner: string }
	| { readonly _tag: "Announced" }
	| { readonly _tag: "Refused" };

const PlacedPart = Schema.Struct({ id: Schema.String, atOffset: Schema.Int });

/**
 * The reply as the segment has it so far: the text, and where in that text the
 * bot made each collaboration and tool call. Stored as parts in that order.
 */
export const ReplyDraft = Schema.Struct({
	content: Schema.String,
	collaborations: Schema.Array(PlacedPart),
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

const OptionalCount = Schema.optional(Schema.Int);

/**
 * A call the suspended turn waits on, and what it must still match to run
 * (see `ToolCallRepository.ApprovalBinding`). A connection's call is stored
 * flat, untagged, as checkpoints were before built-in tools asked for approval.
 */
const CheckpointApproval = Schema.Union([
	Schema.Struct({
		approvalId: Schema.String,
		tool: Schema.String,
		connectionId: Schema.String,
		connectionRevision: Schema.Int,
		remoteToolName: Schema.String,
	}),
	Schema.Struct({
		approvalId: Schema.String,
		tool: Schema.String,
		builtIn: Schema.Literal(true),
	}),
]);

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
	/** The model calls made before the turn suspended, which cap the steps a resumed segment has left. */
	modelCalls: OptionalCount,
	/** The prompt's size at the turn's first model call, which a resumed segment keeps. */
	contextTokens: OptionalCount,
});
export type TurnCheckpoint = typeof TurnCheckpoint.Type;

/** How much of its model's context window a turn's prompt took. */
export interface ContextMeasurement {
	contextTokens?: number;
	/** The window the prompt was read with. */
	contextCapacity?: number;
}

/** How a reply completed, for what reacts to it (see `TurnCompleted`). */
export interface TurnCompletion extends ContextMeasurement {
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
	error: UserText | null;
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

/** Locks the turn found by `condition`, and reads its state and conversation. */
const lockedTurn = (condition: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({ ...stateColumns, conversationId: turn.conversationId, botId: turn.botId })
				.from(turn)
				.where(condition)
				.limit(1)
				.for("update"),
		),
		([row]) =>
			row && {
				id: row.id,
				conversationId: row.conversationId,
				botId: row.botId,
				state: stateOf(row),
			},
	);

function notRunnable(reason: string, ended?: Ended): NotRunnable {
	return { _tag: "NotRunnable", reason, ended };
}

/** How people are told a turn ended mid-run. */
function endAnnouncement(
	reply: {
		turnId: string;
		conversationId: string;
		workspaceId: string;
		botId: string;
		messageId: string;
		content: string;
	},
	ended: Ended,
): ConversationEvent {
	return ended.state === "failed"
		? ConversationEvent.TurnFailed({
				conversationId: reply.conversationId,
				workspaceId: reply.workspaceId,
				turnId: reply.turnId,
				botId: reply.botId,
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

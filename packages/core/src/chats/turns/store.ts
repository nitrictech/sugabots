export * as TurnStore from "./store.ts";

import {
	type FilePart,
	type Message,
	messagePartsFor,
	stepThinkingSchema,
} from "@sugabots/contracts";
import type { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { type DomainError, type UserText, userText } from "@sugabots/errors";
import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, ErrorReporter, Layer, Schema } from "effect";
import { askerColumns, askerOfMessage } from "../../authentication/turn-facts.ts";
import type { BlobStore } from "../../blob-store/blob-store.ts";
import {
	type Database,
	query,
	serviceOperations,
	Transaction,
	transaction,
	writtenRow,
} from "../../database/database.ts";
import {
	ACTIVE_TURN_STATUSES,
	chat,
	message,
	messageReaction,
	type StoredMessagePart,
	type TurnEndRequest,
	type TurnReason,
	type TurnSteer,
	turn,
} from "../../database/schema.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import type { AdmittedProject, Principal } from "../../principal.ts";
import type { EndsTurn } from "../../proofs/ends-turn.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import {
	type ParticipantRow,
	reactionColumns,
	toMessage,
	toReactions,
} from "../store/participants.ts";
import {
	executionFence,
	type FenceRefusal,
	fenced,
	fenceRefusal,
	holdTurnForToolWrite,
} from "./fence.ts";
import { recordJoin } from "./joins.ts";
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
	unfinishedCallsMessage,
} from "./lifecycle.ts";
import { approvalBindingSchema, type CallPlan, callPlanSchema } from "./loop-values.ts";
import { answersAlone, lockOpening, type TurnRequest, TurnRequests } from "./requests.ts";
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
 * What the bot loop records while a turn runs demands `RunsTurn`, and each
 * such write passes the turn's fence under its lock (see `fence.ts`): one for
 * a turn that has ended, or for an execution a newer one has taken over,
 * fails with that refusal and writes nothing.
 *
 * A bot's turn writes a reply into its chat. A system bot's turn (the
 * Compaction bot compacting) writes something else
 * instead, so those have commands of their own and announce nothing.
 */
export interface Interface {
	/** Asks for a bot's turn, in the caller's transaction (see `Turns.ask`). */
	readonly ask: (request: TurnRequest) => Effect.Effect<void>;
	/**
	 * Opens the turn a bot takes on a trigger message, with its reply: starts
	 * it, opens it again for a retry, or finds it again for the same run after
	 * a crash. A turn that may not run again says why, and how it ended if
	 * opening it ended it. An automation run that takes no more work (see
	 * `WorkAdmission`) opens no turn, and ends the one it finds.
	 */
	readonly openReplyTurn: (
		request: ReplyTurnRequest,
	) => Effect.Effect<OpenedReplyTurn | NotRunnable>;
	/** Opens a system bot's turn on the message it works up to, as `openReplyTurn` does. */
	readonly openSystemBotTurn: (
		request: SystemBotTurnRequest,
	) => Effect.Effect<OpenedSystemBotTurn | NotRunnable>;
	/**
	 * Begins the turn's step `step`, its `step`th model request counted from 0:
	 * resumes a turn that waited once every approval it waited for is decided,
	 * and counts a step begun again after a crash as a run that got nowhere,
	 * which may end the turn. Says what the step continues from, that the
	 * turn still waits, or that beginning it ended the turn.
	 */
	readonly beginStep: <P, T>(
		runsTurn: RunsTurn<P, T>,
		step: number,
	) => Effect.Effect<BegunStep, FenceRefusal>;
	/** The running turn's reply, and where it left off; none before its first step. */
	readonly current: <P, T>(
		runsTurn: RunsTurn<P, T>,
	) => Effect.Effect<
		{ readonly reply: ReplyTurn; readonly checkpoint: TurnCheckpoint | undefined },
		FenceRefusal
	>;
	/** Persists the reply so far, so a crash loses at most a second of text. */
	readonly saveReply: <P, T>(
		runsTurn: RunsTurn<P, T>,
		draft: ReplyDraft,
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Keeps the reply as `draft` has it in the turn's checkpoint too, for a
	 * step whose model request stopped before it was recorded, so how the run
	 * ends keeps what it wrote.
	 */
	readonly keepReply: <P, T>(
		runsTurn: RunsTurn<P, T>,
		draft: ReplyDraft,
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Records a step's model request: the reply with the step's text, the
	 * messages the model answered with, and the tool calls it made, each
	 * waiting for its result. The step's prompt is kept from the first step on.
	 */
	readonly recordModelRequest: <P, T>(
		runsTurn: RunsTurn<P, T>,
		recorded: RecordedModelRequest,
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Keeps how each of the last step's calls is to be made, before any is
	 * sent; a call planned already keeps its plan.
	 */
	readonly planCalls: <P, T>(
		runsTurn: RunsTurn<P, T>,
		plans: ReadonlyArray<{ readonly toolCallId: string; readonly plan: CallPlan }>,
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Places the tool call `toolCallId`, a `tool_call` row, in the reply where
	 * the reply's text has reached, and returns how far that is.
	 */
	readonly placeToolCall: <P, T>(
		runsTurn: RunsTurn<P, T>,
		toolCallId: string,
	) => Effect.Effect<number, FenceRefusal>;
	/**
	 * Records what the model is given back for some of the last step's tool
	 * calls. Once every call has its result, they join the messages the next
	 * step's model request continues from.
	 */
	readonly recordToolResults: <P, T>(
		runsTurn: RunsTurn<P, T>,
		results: readonly StepCallResult[],
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Attaches `file` to the turn's reply, after the files already on it, and
	 * announces what the reply carries now, for the execution of the turn
	 * `executionNumber`, through the fence for tool writes. Fails with
	 * `ReplyEnded` once the turn is no longer running, or a newer execution
	 * took it over; `ResourceHidden` or `ActionForbidden` once its asker can
	 * no longer change things in the chat; and `TooManyReplyFiles` once the
	 * reply carries as many as a message can.
	 */
	readonly attachFile: (
		turn: ReplyTurn & { readonly executionNumber: number },
		file: ReplyFile,
	) => Effect.Effect<
		FilePart,
		| ReplyEnded
		| ResourceHidden
		| ActionForbidden
		| ChatFileStore.TooManyReplyFiles
		| ChatFileStore.FileTooLarge
		| BlobStore.Failure
	>;
	/** The files the turn's reply carries, in the order attached. */
	readonly replyFiles: (turn: ReplyTurn) => Effect.Effect<readonly FilePart[]>;
	/**
	 * Parks an admitted turn until members decide its last step's approvals,
	 * which must still match their recorded bindings when they run. Returns `false` if asked to stop.
	 */
	readonly suspend: <P, T>(
		runsTurn: RunsTurn<P, T>,
		admitted: WorkAdmission.ApprovalAdmission,
		approvals: readonly Omit<ToolCallStore.PendingToolApproval, "atOffset">[],
	) => Effect.Effect<boolean, FenceRefusal>;
	/** Completes the turn with its reply as it stands. */
	readonly complete: <P, T>(
		runsTurn: RunsTurn<P, T>,
		completion: TurnCompletion,
	) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Records the run as failed, telling members `userMessage`, and returns
	 * whether the turn runs again: only if `mayRunAgain` and
	 * `runsAgainAfterFailure` both allow it. A turn that runs again keeps
	 * when it may, `retryAfterMillis` from now, with its failure.
	 */
	readonly fail: <P, T>(
		runsTurn: RunsTurn<P, T>,
		failure: { userMessage: UserText; mayRunAgain: boolean; retryAfterMillis?: number },
	) => Effect.Effect<boolean, FenceRefusal>;
	/**
	 * Completes an optional turn that wrote no reply, shared no files and made
	 * no tool calls, deleting its empty reply and reacting 👀 to the message it read.
	 */
	readonly staySilent: <P, T>(
		runsTurn: RunsTurn<P, T>,
		completion: TurnCompletion,
	) => Effect.Effect<void, FenceRefusal>;
	/** Whether the turn `runsTurn` is about was asked to end, as the caller's lock on it holds it. */
	readonly endRequested: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<boolean, FenceRefusal>;
	/**
	 * Stops the run short, running or waiting, keeping the reply written so
	 * far, and tells members why of its unfinished tool calls (see
	 * `TurnEndRequest`).
	 */
	readonly cancel: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Ends the turn `endsTurn` is about, whatever its principal still reaches:
	 * as failed, telling members `userMessage`, when it lost its chat or its
	 * step died; or as it was asked to end, which its workflow heard, telling
	 * them why (see `TurnEndRequest`). Refused, like the loop's other writes,
	 * once the turn ended or a newer execution took it over.
	 */
	readonly endLost: <P, T>(
		endsTurn: EndsTurn<P, T>,
		ending: LostEnding,
	) => Effect.Effect<void, FenceRefusal>;
	readonly completeSystemBotTurn: (
		turnId: string,
		contextTokens: number | undefined,
	) => Effect.Effect<void>;
	readonly failSystemBotTurn: (turnId: string, userMessage: UserText) => Effect.Effect<void>;
	/**
	 * Where the turn stands for whoever runs a step of it: running, with its
	 * current execution's number; asked to stop, as when its automation run
	 * ended; failed, to run again; or ended, or gone.
	 */
	readonly standing: (turnId: string) => Effect.Effect<TurnStanding>;
	/**
	 * Ends the active or retrying turn of `executionId`. Returns `undefined` if there is none.
	 */
	readonly abandon: (executionId: string, outcome: Abandonment) => Effect.Effect<Ended | undefined>;
	/**
	 * Records that a write/delete tool call crossed its dispatch boundary, so the turn
	 * is not started again from here on, after a failure or after its server
	 * stopped without saying how the run ended.
	 */
	readonly markActed: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<void, FenceRefusal>;
	/**
	 * Withdraws the approvals nobody has decided that the turn `turnId` waits
	 * for, telling members `userMessage` of each, and asks the turn to end for
	 * `request`: its asker or bot lost the chat, or the approval expired. Its
	 * workflow, told to stop, ends it through `turns.endLost`. A turn not
	 * waiting, or already asked to stop, is left as it is. Withdraws as a steer
	 * does (see `ToolCallStore.withdrawPending`), but a steered turn goes on.
	 */
	readonly withdrawApprovals: (
		turnId: string,
		request: Extract<TurnEndRequest, "lost_reach" | "approval_expired">,
		userMessage: UserText,
	) => Effect.Effect<void>;
	/**
	 * Makes the member's message `steer.messageId` a steer of the turn `turnId`, once
	 * its row is locked, if the turn is still running or waiting for approvals
	 * and nobody interrupted it: the turn reads it before its next step. A
	 * waiting turn's approvals are withdrawn, so it reads the message next;
	 * says which, with the workflow execution to tell. A turn that has ended,
	 * or is ending, takes no steer, and the message needs a turn of its own.
	 */
	readonly steer: (turnId: string, steer: TurnSteer) => Effect.Effect<SteerOutcome>;
	/**
	 * Interrupts the turn `turnId`, once its row is locked: one waiting for
	 * approvals or to run again ends at once, its approvals withdrawn, and its
	 * workflow execution is returned to be told; a running one is marked
	 * interrupted, which the process running its step hears at once and its
	 * next step finds. A turn that has ended is left as it is.
	 */
	readonly interrupt: (turnId: string) => Effect.Effect<{ readonly executionToTell?: string }>;
	/**
	 * Cancels the turns waiting in these chats, and asks the running ones to
	 * stop, because the automation run they work for ended. A running turn another
	 * transaction holds is skipped: its workflow is recording how it ended.
	 * Returns the workflow executions of the waiting turns it cancelled, which
	 * are still waiting and have to be told.
	 */
	readonly cancelUnder: (chatIds: readonly string[]) => Effect.Effect<readonly string[]>;
}

export const AUTOMATION_RUN_ENDED = "The automation run has ended";

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnStore") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnStore");
	const { emit } = yield* ChatEvents.Service;
	const admission = yield* WorkAdmission.Service;
	const toolCalls = yield* ToolCallStore.Service;
	const files = yield* ChatFileStore.Service;
	const requests = yield* TurnRequests.Service;

	/**
	 * Writes the state the lifecycle decided, plus what else the command
	 * records, and answers the time it wrote it at: when the turn finished, if
	 * `next` ends it. Only failing records the turn as `retrying`. A turn that
	 * ends clears its checkpoint unless the ending records one. A turn that
	 * ends without answering for good hands its unread steers on if it still reaches the chat.
	 */
	const write = (
		turnId: string,
		next: TurnState,
		recorded: Partial<
			Pick<
				typeof turn.$inferInsert,
				"checkpoint" | "retrying" | "retryAt" | keyof ContextMeasurement
			>
		> = {},
		{ handOnSteers = true } = {},
	) =>
		Effect.gen(function* () {
			const now = yield* DateTime.nowAsDate;
			const active = next.status === "running" || next.status === "waiting";
			const unanswered =
				next.status === "cancelled" || (next.status === "failed" && !recorded.retrying);
			if (unanswered && handOnSteers && next.endRequested !== "lost_reach") {
				yield* handOnUnreadSteers(turnId);
			}
			yield* query((db) =>
				db
					.update(turn)
					.set({
						status: next.status,
						executionId: next.executionId,
						endRequested: next.endRequested,
						runs: next.runs,
						error: next.status === "failed" ? next.userMessage : null,
						finishedAt: active ? null : now,
						retrying: false,
						retryAt: null,
						...(active ? {} : { checkpoint: null }),
						...(!active && !recorded.retrying && { admission: null }),
						...recorded,
					})
					.where(eq(turn.id, turnId)),
			);
			return now;
		});

	/**
	 * Asks for a turn for the unread steers of the turn `turnId`, which is ending
	 * without answering for good, in the transaction that ends it, before its
	 * checkpoint, which says which steers it read, goes: a steer either reaches
	 * its turn or starts one of its own. The new turn answers the latest of
	 * them, for its asker, and reads the earlier ones before it.
	 */
	const handOnUnreadSteers = (turnId: string) =>
		Effect.gen(function* () {
			const [ending] = yield* query((db) =>
				db
					.select({
						chatId: turn.chatId,
						botId: turn.botId,
						askerId: turn.askerId,
						steers: turn.steers,
						checkpoint: turn.checkpoint,
					})
					.from(turn)
					.where(eq(turn.id, turnId))
					.limit(1),
			);
			if (!ending || ending.steers.length === 0) return;
			const checkpoint =
				ending.checkpoint === null
					? undefined
					: yield* Schema.decodeUnknownEffect(TurnCheckpoint)(ending.checkpoint).pipe(Effect.orDie);
			const read = new Set(checkpoint?.steersRead ?? []);
			const latest = ending.steers.findLast(({ messageId }) => !read.has(messageId));
			if (!latest) return;
			// Only its asker steers a turn, so the new turn acts for them too.
			yield* ask(
				{
					chatId: ending.chatId,
					botId: ending.botId,
					triggerMessageId: latest.messageId,
					reason: latest.reason,
				},
				ending.askerId,
			);
		});

	/**
	 * Asks for a turn on `request` (see `Turns.ask`), for `askerId` when the
	 * caller knows who it acts for, else as `askerOfMessage` works it out.
	 */
	const ask = (request: TurnRequest, askerId?: string | null) =>
		Effect.gen(function* () {
			const keyedBy = answersAlone(request.reason)
				? undefined
				: askerId !== undefined
					? askerId
					: (yield* query((db) => askerOfMessage(db, request))).askerId;
			const admission = yield* requests.ask(
				keyedBy === undefined ? request : { ...request, askerId: keyedBy },
			);
			if (admission === "coalesced" && keyedBy) {
				const joined = yield* TurnRequests.waitingFor(request, keyedBy);
				if (joined) {
					yield* recordJoin(request.triggerMessageId, {
						botId: joined.botId,
						triggerMessageId: joined.triggerMessageId,
					});
				}
			}
			if (admission === "waiting") yield* emit([ChatEvent.TurnQueued({ chatId: request.chatId })]);
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
						execution: turn.executionNumber,
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

	const abandon = (
		locked: { id: string; state: TurnState },
		{ handOnSteers, ...outcome }: Abandonment,
	) =>
		Effect.gen(function* () {
			const decided = transition(locked.state, TurnEvent.Abandon(outcome));
			if (decided._tag !== "Next" || decided.followUp?._tag !== "End") return undefined;
			const writtenAt = yield* write(locked.id, decided.state, {}, { handOnSteers });
			return yield* endRun(locked.id, decided.state, decided.followUp.userMessage, writtenAt);
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

	/**
	 * Locks the turn `runsTurn` is about, with its reply and checkpoint, for a
	 * write it guards, once it passes the turn's fence: fails with the fence's
	 * refusal once the turn has ended or a newer execution took it over, so
	 * nothing more is recorded for it.
	 */
	const lockRunningTurn = <P, T>(runsTurn: RunsTurn<P, T>, lock: "update" | "share" = "update") =>
		Effect.gen(function* () {
			const turnId = runsTurn.turn.value;
			const [row] = yield* query((db) =>
				db
					.select({
						...stateColumns,
						botId: turn.botId,
						checkpoint: turn.checkpoint,
						execution: turn.executionNumber,
					})
					.from(turn)
					.where(fenced(runsTurn))
					.limit(1)
					.for(lock),
			);
			if (!row) return yield* Effect.fail(yield* fenceRefusal(runsTurn));
			const [reply] = yield* query((db) =>
				db
					.select({ messageId: message.id })
					.from(message)
					.where(eq(message.turnId, turnId))
					.limit(1),
			);
			if (!reply) return yield* Effect.die(new Error("A running turn has no reply message"));
			const replyTurn: ReplyTurn = {
				turnId,
				chatId: runsTurn.chat,
				workspaceId: runsTurn.workspace,
				botId: row.botId,
				messageId: reply.messageId,
			};
			const checkpoint =
				row.checkpoint === null
					? undefined
					: yield* Schema.decodeUnknownEffect(TurnCheckpoint)(row.checkpoint).pipe(Effect.orDie);
			return {
				id: row.id,
				state: stateOf(row),
				reply: replyTurn,
				checkpoint,
				execution: row.execution,
			};
		});

	/** Writes the reply's text and parts, and its status when it ends. */
	const writeReply = (
		reply: Pick<ReplyTurn, "messageId">,
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
	 * Stops the run the caller locked short, keeping the reply written so far,
	 * tells members why of its unfinished tool calls (see `TurnEndRequest`),
	 * and announces it was interrupted.
	 */
	const stopShort = (locked: Effect.Success<ReturnType<typeof lockRunningTurn>>) =>
		Effect.gen(function* () {
			const decided = transition(locked.state, TurnEvent.Cancel());
			if (decided._tag !== "Next") return;
			const { reply } = locked;
			const draft = draftOf(locked.checkpoint);
			yield* writeReply(reply, draft, "cancelled");
			const finishedAt = yield* write(locked.id, decided.state);
			yield* toolCalls.abandonUnfinished(
				[locked.id],
				unfinishedCallsMessage(locked.state.endRequested),
			);
			yield* emit([
				ChatEvent.TurnInterrupted({
					chatId: reply.chatId,
					workspaceId: reply.workspaceId,
					turnId: locked.id,
					botId: reply.botId,
					messageId: reply.messageId,
					execution: locked.execution,
					content: draft.content,
					finishedAt,
				}),
			]);
		});

	/** Writes the turn's checkpoint, leaving its state as it is. */
	const writeCheckpoint = (turnId: string, checkpoint: TurnCheckpoint) =>
		query((db) =>
			db
				.update(turn)
				.set({ checkpoint: Schema.encodeSync(TurnCheckpoint)(checkpoint) })
				.where(eq(turn.id, turnId)),
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
			const decided = transition(existing.state, TurnEvent.Reopen({ executionId }));
			if (decided._tag === "Refused") {
				const { status } = existing.state;
				// It completed or was cancelled, and said so: how it ended stands.
				const endedBefore = status === "done" || status === "cancelled";
				return { ...notRunnable(decided.reason), endedBefore };
			}
			const restarted = decided.followUp?._tag === "Retry";
			const writtenAt = yield* write(
				existing.id,
				decided.state,
				restarted ? { checkpoint: null } : {},
			);
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
						...askerColumns(request),
					})
					.returning({ id: turn.id }),
			).pipe(Effect.flatMap(writtenRow("turn")));
			return created.id;
		});

	/** Ends `existing`, if it is still active, because its automation run takes no more work. */
	const endForEndedAutomation = (existing: { id: string; state: TurnState } | undefined) =>
		Effect.gen(function* () {
			const reason = AUTOMATION_RUN_ENDED;
			const decided =
				existing &&
				transition(
					existing.state,
					existing.state.status === "failed"
						? TurnEvent.AutomationEnded()
						: TurnEvent.Abandon({ status: "cancelled", userMessage: RUN_ENDED }),
				);
			if (!existing || decided?._tag !== "Next" || decided.followUp?._tag !== "End") {
				const status = existing?.state.status;
				return { ...notRunnable(reason), endedBefore: status === "done" || status === "cancelled" };
			}
			const writtenAt = yield* write(existing.id, decided.state);
			const ended = yield* endRun(
				existing.id,
				decided.state,
				decided.followUp.userMessage,
				writtenAt,
			);
			return notRunnable(reason, ended);
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

	/** The draft a running turn's reply is at: its checkpoint's, or empty before its first step. */
	const draftOf = (checkpoint: TurnCheckpoint | undefined): ReplyDraft =>
		checkpoint?.reply ?? emptyReply;

	const openFirstReply = (request: ReplyTurnRequest) =>
		Effect.gen(function* (): Effect.fn.Return<OpenedReplyTurn, never, Database | Transaction> {
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
			const replyIdentity = { turnId, retryKey: turnId };
			const created = yield* query((db) =>
				request.reason === "interview"
					? db
							.update(message)
							.set(replyIdentity)
							.where(eq(message.id, request.triggerMessageId))
							.returning()
					: db
							.insert(message)
							.values({ ...replyValues, ...replyIdentity })
							.returning(),
			).pipe(Effect.flatMap(writtenRow("message")));
			const reply = toMessage(created, request.author);
			yield* announceStart(request, turnId, reply);
			return { _tag: "Opened", turnId, reply };
		});

	const resumeReply = (turnId: string, author: ReplyTurnRequest["author"]) =>
		Effect.gen(function* (): Effect.fn.Return<OpenedReplyTurn, never, Database | Transaction> {
			const [found] = yield* query((db) =>
				db.select().from(message).where(eq(message.turnId, turnId)).limit(1),
			);
			if (!found) return yield* Effect.die(new Error("A running turn has no reply message"));
			return {
				_tag: "Opened",
				turnId,
				reply: toMessage(found, author),
			};
		});

	const restartReply = (turnId: string, request: ReplyTurnRequest) =>
		Effect.gen(function* (): Effect.fn.Return<OpenedReplyTurn, never, Database | Transaction> {
			const [retried] = yield* query((db) =>
				db
					.update(message)
					.set({ status: "writing", parts: [], content: "" })
					.where(eq(message.turnId, turnId))
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
			yield* announceStart(request, turnId, reply);
			return { _tag: "Opened", turnId, reply };
		});

	return Service.of({
		ask: (request) => operation("ask", transaction(ask(request))),
		openReplyTurn: (request) =>
			operation(
				"openReplyTurn",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						OpenedReplyTurn | NotRunnable,
						never,
						Database | Transaction
					> {
						const refused = yield* admission.refusal(request.chatId);
						if (refused === "chatUnavailable") {
							const retry = yield* lockedTurn(
								and(
									onTrigger(request),
									eq(turn.executionId, request.executionId),
									eq(turn.retrying, true),
								),
							);
							const ended =
								retry &&
								(yield* abandon(retry, {
									status: "cancelled",
									userMessage: TURN_CANCELLED,
									handOnSteers: false,
								}));
							return notRunnable("The chat is unavailable", ended);
						}
						// As a message deciding whether to join the turn or steer it holds
						// its opening, it sees the turn opened or not, never in between.
						yield* lockOpening(request);
						const existing = yield* lockedTurn(onTrigger(request));
						if (refused === "automationEnded") return yield* endForEndedAutomation(existing);
						if (!existing) return yield* openFirstReply(request);
						const reopened = yield* reopen(existing, request.executionId);
						if (reopened._tag === "NotRunnable") return reopened;
						if (reopened.followUp?._tag === "Resume")
							return yield* resumeReply(existing.id, request.author);
						return yield* restartReply(existing.id, request);
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

		beginStep: (runsTurn, step) =>
			operation(
				"beginStep",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						BegunStep,
						FenceRefusal,
						Database | Transaction
					> {
						const locked = yield* lockRunningTurn(runsTurn);
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						const executionChanged = earlier.execution !== runsTurn.execution;
						const resumesWriting = executionChanged && locked.state.endRequested === null;
						const reply = resumesWriting ? replyForRestart(earlier) : earlier.reply;
						const resumedCheckpoint = resumesWriting
							? { ...earlier, reply, replyBeforeUnfinishedStep: undefined }
							: earlier;
						if (resumesWriting) {
							yield* writeReply(locked.reply, reply);
							yield* emit([
								ChatEvent.ReplyExecutionStarted({
									chatId: locked.reply.chatId,
									messageId: locked.reply.messageId,
									execution: runsTurn.execution,
									content: reply.content,
									thinking: reply.thinking,
								}),
							]);
						}
						let state = locked.state;
						if (state.status === "waiting") {
							const waitingOn = (locked.checkpoint?.approvals ?? []).map(
								({ approvalId }) => approvalId,
							);
							const decided = yield* toolCalls.decisions(locked.id, waitingOn);
							if (waitingOn.some((approvalId) => decided.get(approvalId)?.status === "pending")) {
								if (executionChanged) {
									yield* writeCheckpoint(locked.id, {
										...resumedCheckpoint,
										execution: runsTurn.execution,
									});
								}
								return { _tag: "Waiting", approvals: waitingOn };
							}
							const resumed = transition(state, TurnEvent.ResumeAfterApprovals());
							if (resumed._tag === "Refused") return { _tag: "Ended" };
							yield* write(locked.id, resumed.state);
							state = resumed.state;
						}
						const again = locked.checkpoint?.begun === step;
						const begun = transition(state, TurnEvent.BeginStep({ again }));
						if (begun._tag === "Refused") return { _tag: "Ended" };
						const checkpoint: TurnCheckpoint = {
							...resumedCheckpoint,
							execution: runsTurn.execution,
							begun: step,
						};
						const writtenAt = yield* write(locked.id, begun.state, {
							checkpoint: Schema.encodeSync(TurnCheckpoint)(checkpoint),
						});
						if (begun.followUp?._tag === "End") {
							yield* endRun(locked.id, begun.state, begun.followUp.userMessage, writtenAt);
							return { _tag: "Ended" };
						}
						return { _tag: "Begun", reply: locked.reply, checkpoint: locked.checkpoint };
					}),
				),
			),

		current: (runsTurn) =>
			operation(
				"current",
				transaction(
					Effect.map(lockRunningTurn(runsTurn, "share"), ({ reply, checkpoint }) => ({
						reply,
						checkpoint,
					})),
				),
			),

		keepReply: (runsTurn, draft) =>
			operation(
				"keepReply",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						yield* writeCheckpoint(locked.id, {
							...earlier,
							reply: draft,
							replyBeforeUnfinishedStep: earlier.replyBeforeUnfinishedStep ?? earlier.reply,
						});
						yield* writeReply(locked.reply, draft);
					}),
				),
			),

		saveReply: (runsTurn, draft) =>
			operation(
				"saveReply",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						yield* writeReply(locked.reply, draft);
					}),
				),
			),

		recordModelRequest: (runsTurn, recorded) =>
			operation(
				"recordModelRequest",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						const checkpoint: TurnCheckpoint = {
							...earlier,
							modelInput: earlier.modelInput ?? recorded.modelInput,
							messages: [
								...earlier.messages,
								...(recorded.steers?.messages ?? []),
								...recorded.messages,
							],
							steersRead: [...(earlier.steersRead ?? []), ...(recorded.steers?.ids ?? [])],
							reply: recorded.reply,
							replyBeforeUnfinishedStep: undefined,
							execution: runsTurn.execution,
							steps: earlier.steps + 1,
							contextTokens: earlier.contextTokens ?? recorded.contextTokens,
							calls: recorded.last
								? []
								: recorded.calls.map(({ toolCallId, toolName, input }) => ({
										toolCallId,
										toolName,
										input,
									})),
							approvals: [],
							answered: recorded.last || recorded.calls.length === 0,
						};
						yield* writeCheckpoint(locked.id, checkpoint);
						yield* writeReply(locked.reply, recorded.reply);
					}),
				),
			),

		planCalls: (runsTurn, plans) =>
			operation(
				"planCalls",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						const planOf = new Map(plans.map(({ toolCallId, plan }) => [toolCallId, plan]));
						yield* writeCheckpoint(locked.id, {
							...earlier,
							calls: earlier.calls.map((call) =>
								call.plan === undefined && planOf.has(call.toolCallId)
									? { ...call, plan: planOf.get(call.toolCallId) }
									: call,
							),
						});
					}),
				),
			),

		placeToolCall: (runsTurn, toolCallId) =>
			operation(
				"placeToolCall",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						const atOffset = earlier.reply.content.length;
						if (earlier.reply.toolCalls.some((call) => call.id === toolCallId)) return atOffset;
						const reply: ReplyDraft = {
							...earlier.reply,
							toolCalls: [...earlier.reply.toolCalls, { id: toolCallId, atOffset }],
						};
						yield* writeCheckpoint(locked.id, { ...earlier, reply });
						yield* writeReply(locked.reply, reply);
						return atOffset;
					}),
				),
			),

		recordToolResults: (runsTurn, results) =>
			operation(
				"recordToolResults",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						const resultOf = new Map(results.map((result) => [result.toolCallId, result.output]));
						const calls = earlier.calls.map((call) =>
							call.result === undefined && resultOf.has(call.toolCallId)
								? { ...call, result: resultOf.get(call.toolCallId) }
								: call,
						);
						const unanswered = calls.some((call) => call.result === undefined);
						const checkpoint: TurnCheckpoint = unanswered
							? { ...earlier, calls }
							: {
									...earlier,
									messages: [...earlier.messages, toolMessage(calls)],
									calls: [],
									approvals: [],
								};
						yield* writeCheckpoint(locked.id, checkpoint);
					}),
				),
			),

		attachFile: (reply, file) =>
			operation(
				"attachFile",
				files.withReplyFile(
					{ chatId: reply.chatId, messageId: reply.messageId, ...file },
					(stored) =>
						transaction(
							Effect.gen(function* () {
								yield* holdTurnForToolWrite(
									executionFence(reply.turnId, reply.executionNumber),
									"running",
								).pipe(Effect.mapError(() => new ReplyEnded()));
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

		suspend: (runsTurn, admitted, approvals) =>
			operation(
				"suspend",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const decided = transition(locked.state, TurnEvent.Suspend());
						if (decided._tag !== "Next") return false;
						const earlier = locked.checkpoint ?? emptyCheckpoint;
						// The calls exist once the turn suspends, so only now are they placed
						// in the reply, after what it has written.
						const atOffset = earlier.reply.content.length;
						const placed = approvals.map((call) => ({ ...call, atOffset }));
						const reply: ReplyDraft = {
							...earlier.reply,
							toolCalls: [
								...earlier.reply.toolCalls,
								...placed.filter((call) => !call.reopen).map((call) => ({ id: call.id, atOffset })),
							],
						};
						const checkpoint: TurnCheckpoint = {
							...earlier,
							reply,
							approvals: approvals.map(({ approvalId, sdkToolCallId, tool, binding }) => ({
								approvalId,
								toolCallId: sdkToolCallId,
								tool,
								binding,
							})),
							waited: true,
						};
						yield* write(locked.id, decided.state, {
							checkpoint: Schema.encodeSync(TurnCheckpoint)(checkpoint),
						});
						yield* toolCalls.requestApprovals(
							{
								chatId: locked.reply.chatId,
								messageId: locked.reply.messageId,
								turnId: locked.id,
							},
							placed,
						);
						yield* writeReply(locked.reply, reply);
						yield* emit([
							ChatEvent.TurnSuspended({
								chatId: locked.reply.chatId,
								workspaceId: locked.reply.workspaceId,
								approvalCallIds: approvals.map(({ id }) => id),
								approvalIds: approvals.map(({ approvalId }) => approvalId),
								turnId: locked.id,
							}),
						]);
						return true;
					}),
				).pipe(WorkAdmission.withApprovalAdmission(admitted, runsTurn.chat)),
			),

		staySilent: (runsTurn, completion) =>
			operation(
				"staySilent",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const decided = transition(locked.state, TurnEvent.Complete());
						if (decided._tag !== "Next") return;
						const { reply } = locked;
						if (completion.handsOnUnreadSteers) yield* handOnUnreadSteers(locked.id);
						const checkpoint = locked.checkpoint;
						yield* write(locked.id, decided.state, {
							...measurementColumns(completion),
							...(checkpoint
								? {
										checkpoint: Schema.encodeSync(TurnCheckpoint)(checkpoint),
									}
								: {}),
						});
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

		complete: (runsTurn, completion) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						const decided = transition(locked.state, TurnEvent.Complete());
						if (decided._tag !== "Next") return;
						const { reply } = locked;
						const draft = draftOf(locked.checkpoint);
						if (completion.handsOnUnreadSteers) yield* handOnUnreadSteers(locked.id);
						yield* writeReply(reply, draft, "complete");
						const finishedAt = yield* write(
							locked.id,
							decided.state,
							measurementColumns(completion),
						);
						yield* emit([
							ChatEvent.TurnCompleted({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: reply.botId,
								messageId: reply.messageId,
								execution: locked.execution,
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

		fail: (runsTurn, { userMessage, mayRunAgain, retryAfterMillis }) =>
			operation(
				"fail",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						// A turn asked to end ends as it was asked, rather than failing or running again.
						if (locked.state.endRequested) {
							yield* stopShort(locked);
							return false;
						}
						const decided = transition(locked.state, TurnEvent.Fail({ userMessage }));
						if (decided._tag !== "Next") return false;
						const { reply } = locked;
						const willRetry = mayRunAgain && runsAgainAfterFailure(locked.state);
						const now = yield* DateTime.now;
						const retryAt =
							willRetry && retryAfterMillis !== undefined
								? DateTime.toDateUtc(DateTime.addDuration(now, Duration.millis(retryAfterMillis)))
								: null;
						yield* writeReply(reply, draftOf(locked.checkpoint), "failed");
						yield* write(locked.id, decided.state, { retrying: willRetry, retryAt });
						yield* toolCalls.abandonUnfinished([locked.id], userMessage);
						yield* emit([
							ChatEvent.TurnFailed({
								chatId: reply.chatId,
								workspaceId: reply.workspaceId,
								turnId: locked.id,
								botId: reply.botId,
								messageId: reply.messageId,
								execution: locked.execution,
								userMessage,
								willRetry,
							}),
						]);
						return willRetry;
					}),
				),
			),

		endRequested: (runsTurn) =>
			operation(
				"endRequested",
				transaction(
					Effect.map(
						lockRunningTurn(runsTurn, "share"),
						(locked) => locked.state.endRequested !== null,
					),
				),
			),

		cancel: (runsTurn) =>
			operation("cancel", transaction(Effect.flatMap(lockRunningTurn(runsTurn), stopShort))),

		endLost: (endsTurn, ending) =>
			operation(
				"endLost",
				transaction(
					Effect.gen(function* () {
						// Fenced like any write the loop makes: an execution a newer one
						// took over ends nothing.
						const locked = yield* lockAndTransition(
							fenced(endsTurn),
							ending._tag === "AsRequested"
								? TurnEvent.EndAsRequested()
								: TurnEvent.Abandon({ status: "failed", userMessage: ending.userMessage }),
						);
						if (!locked) return yield* Effect.fail(yield* fenceRefusal(endsTurn));
						const { decided } = locked;
						if (decided._tag !== "Next" || decided.followUp?._tag !== "End") return;
						const writtenAt = yield* write(
							locked.id,
							decided.state,
							{},
							{
								handOnSteers: ending._tag !== "LostReach",
							},
						);
						yield* endRun(locked.id, decided.state, decided.followUp.userMessage, writtenAt);
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

		standing: (turnId) =>
			operation(
				"standing",
				Effect.map(
					query((db) =>
						db
							.select({
								status: turn.status,
								requested: turn.endRequested,
								executionNumber: turn.executionNumber,
								retrying: turn.retrying,
								retryAt: turn.retryAt,
							})
							.from(turn)
							.where(eq(turn.id, turnId))
							.limit(1),
					),
					([row]): TurnStanding => {
						if (row?.retrying) {
							return {
								_tag: "Retrying",
								executionNumber: row.executionNumber,
								at: row.retryAt ?? undefined,
							};
						}
						// A turn that has vanished has ended too.
						if (!row || !(ACTIVE_TURN_STATUSES as readonly string[]).includes(row.status)) {
							return { _tag: "Ended" };
						}
						if (row.requested) return { _tag: "StopRequested" };
						return { _tag: "Running", executionNumber: row.executionNumber };
					},
				),
			),

		abandon: (executionId, outcome) =>
			operation(
				"abandon",
				transaction(
					Effect.gen(function* () {
						const owned = and(
							eq(turn.executionId, executionId),
							or(inArray(turn.status, [...ACTIVE_TURN_STATUSES]), eq(turn.retrying, true)),
						);
						const locked = yield* lockedTurn(owned);
						if (!locked) return undefined;
						return yield* abandon(locked, outcome);
					}),
				),
			),

		markActed: (runsTurn) =>
			operation(
				"markActed",
				transaction(
					Effect.gen(function* () {
						const locked = yield* lockRunningTurn(runsTurn);
						yield* query((db) =>
							db.update(turn).set({ writeOrDeleteStarted: true }).where(eq(turn.id, locked.id)),
						);
					}),
				),
			),

		steer: (turnId, steer) =>
			operation(
				"steer",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<SteerOutcome, never, Database | Transaction> {
						const locked = yield* lockedTurn(eq(turn.id, turnId));
						if (!locked || !takesSteers(locked.state)) return { _tag: "NotSteered" };
						yield* query((db) =>
							db
								.update(turn)
								.set({ steers: sql`${turn.steers} || ${JSON.stringify([steer])}::jsonb` })
								.where(eq(turn.id, turnId)),
						);
						if (locked.state.status !== "waiting") return { _tag: "Steered" };
						const approvalIds = yield* toolCalls.withdrawPending(turnId, STEERED_AWAY);
						// Kept with the turn, so its next step tells the model they were
						// withdrawn rather than denied.
						const [kept] = yield* query((db) =>
							db.select({ checkpoint: turn.checkpoint }).from(turn).where(eq(turn.id, turnId)),
						);
						if (kept?.checkpoint) {
							const earlier = yield* Schema.decodeUnknownEffect(TurnCheckpoint)(
								kept.checkpoint,
							).pipe(Effect.orDie);
							yield* writeCheckpoint(turnId, {
								...earlier,
								withdrawnApprovals: [...(earlier.withdrawnApprovals ?? []), ...approvalIds],
							});
						}
						const executionId = locked.state.executionId;
						return executionId && approvalIds.length > 0
							? { _tag: "Steered", withdrawn: { executionId, approvalIds } }
							: { _tag: "Steered" };
					}),
				),
			),

		interrupt: (turnId) =>
			operation(
				"interrupt",
				transaction(
					Effect.gen(function* () {
						const [locked] = yield* query((db) =>
							db
								.select({ ...stateColumns, chatId: turn.chatId })
								.from(turn)
								.where(eq(turn.id, turnId))
								.limit(1)
								.for("update"),
						);
						if (!locked) return {};
						const decided = transition(stateOf(locked), TurnEvent.Interrupt());
						if (decided._tag === "Refused") return {};
						const writtenAt = yield* write(locked.id, decided.state);
						if (decided.followUp?._tag === "AnnounceCancelRequest") {
							yield* emit([ChatEvent.TurnInterruptRequested({ chatId: locked.chatId, turnId })]);
							return {};
						}
						if (decided.followUp?._tag !== "End") return {};
						yield* endRun(locked.id, decided.state, decided.followUp.userMessage, writtenAt);
						return locked.executionId ? { executionToTell: locked.executionId } : {};
					}),
				),
			),

		withdrawApprovals: (turnId, request, userMessage) =>
			operation(
				"withdrawApprovals",
				transaction(
					Effect.gen(function* () {
						const [withdrawn] = yield* query((db) =>
							db
								.update(turn)
								.set({ endRequested: request })
								.where(
									and(eq(turn.id, turnId), eq(turn.status, "waiting"), isNull(turn.endRequested)),
								)
								.returning({ id: turn.id }),
						);
						if (withdrawn) yield* toolCalls.withdrawPending(turnId, userMessage);
					}),
				),
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
								.where(
									and(
										under,
										or(
											eq(turn.status, "waiting"),
											and(eq(turn.status, "failed"), eq(turn.retrying, true)),
										),
									),
								)
								.orderBy(asc(turn.botId), asc(turn.id))
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

export const layerNoDeps = processLayer(Layer.effect(Service, make));

/** Ending a turn ends its tool calls, and retrying a reply removes the files it attached. */
export const layer = layerNoDeps.pipe(Layer.provide([ToolCallStore.layer, ChatFileStore.layer]));

/** Abandonment is how an execution ends a turn it cannot run again. */
export interface Abandonment {
	readonly status: "failed" | "cancelled";
	readonly userMessage: UserText;
	readonly handOnSteers?: false;
}

/**
 * LostEnding tells `endLost` whether the turn failed, lost reach and must
 * keep its unread steers in the chat, or should end as requested.
 */
export type LostEnding =
	| { readonly _tag: "Failed" | "LostReach"; readonly userMessage: UserText }
	| { readonly _tag: "AsRequested" };

/**
 * Whether the turn took a message offered as a steer, including which approvals
 * it withdrew and which execution to tell.
 */
type SteerOutcome =
	| {
			readonly _tag: "Steered";
			readonly withdrawn?: {
				readonly executionId: string;
				readonly approvalIds: readonly string[];
			};
	  }
	| { readonly _tag: "NotSteered" };

/** Whether a turn in `state` takes a steer: it is running or waiting for approvals, and nobody interrupted it. */
const takesSteers = (state: TurnState) =>
	(state.status === "running" || state.status === "waiting") && state.endRequested === null;

/** What members are told of the calls a steer withdrew from approval. */
const STEERED_AWAY = userText`Withdrawn: a new message reached the bot before this was decided`;

/** Where a turn stands for whoever runs a step of it (see `standing`). */
export type TurnStanding =
	| { readonly _tag: "Running"; readonly executionNumber: number }
	| { readonly _tag: "StopRequested" }
	/**
	 * Its run failed and its workflow runs it again, no sooner than `at` when
	 * the provider said; `executionNumber` is the execution whose workflow does.
	 */
	| { readonly _tag: "Retrying"; readonly executionNumber: number; readonly at: Date | undefined }
	| { readonly _tag: "Ended" };

/** A file a bot attaches to its reply: its name, media type and bytes. */
interface ReplyFile {
	readonly name: string;
	readonly contentType: string;
	readonly content: Uint8Array;
}

/** A file was shared to a reply after its turn had ended, as when it was cancelled. */
export class ReplyEnded
	extends Schema.TaggedError<ReplyEnded>()("ReplyEnded", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
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
	/**
	 * The turn had ended before it was opened again, as when a workflow takes
	 * an older journal's steps again, and announced how then: nothing more is.
	 */
	readonly endedBefore: boolean;
}

const PlacedPart = Schema.Struct({ id: Schema.String, atOffset: Schema.Int });

/**
 * The reply as the turn has it so far: the text, and where in that text the
 * bot made each tool call. Stored as parts in that order.
 */
export const ReplyDraft = Schema.Struct({
	content: Schema.String,
	toolCalls: Schema.Array(PlacedPart),
	thinking: Schema.optional(Schema.Array(stepThinkingSchema)),
});
export type ReplyDraft = typeof ReplyDraft.Type;

const emptyReply: Readonly<ReplyDraft> = { content: "", toolCalls: [] };

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

/** What the model is given back for a tool call, as the model SDK shapes it. */
const ToolResultOutput = Schema.declare(
	(value: unknown): value is ToolResultPart["output"] =>
		typeof value === "object" && value !== null && "type" in value,
);

/**
 * A call the suspended turn waits on: the model's call `toolCallId`, to the
 * tool `tool` it waits for approval of, and what that must still match to run.
 */
const CheckpointApproval = Schema.Struct({
	approvalId: Schema.String,
	toolCallId: Schema.String,
	tool: Schema.String,
	binding: approvalBindingSchema,
});

/** One of the last step's tool calls, with what the model is given back once it has it. */
const StepCall = Schema.Struct({
	toolCallId: Schema.String,
	toolName: Schema.String,
	input: Schema.Unknown,
	/** How the call is to be made, kept before any of the step's calls is sent. */
	plan: Schema.optional(callPlanSchema),
	result: Schema.optional(ToolResultOutput),
});
export type StepCall = typeof StepCall.Type;

/** The prompt a turn's model requests continue from, fixed at its first step. */
const ModelInput = Schema.Struct({
	model: Schema.String,
	system: Schema.String,
	messages: Schema.Array(
		Schema.Struct({
			role: Schema.Literals(["user", "assistant"]),
			content: Schema.String,
			cacheBreakpoint: Schema.optional(Schema.Literal(true)),
		}),
	),
});
type ModelInput = typeof ModelInput.Type;

/**
 * What a turn keeps so it can carry on from its last step, after waiting for
 * approvals or a restart: the prompt, every step's messages since, the reply
 * so far, and the last step's tool calls until each has its result.
 */
export const TurnCheckpoint = Schema.Struct({
	/** The prompt, once the first step has made its model request. */
	modelInput: Schema.optional(ModelInput),
	/** Every step's messages after the prompt: what the model said, its thinking included, and its tool results. */
	messages: Schema.Array(SdkModelMessage),
	reply: ReplyDraft,
	/** The last completed reply draft when an unfinished step has also saved its writing. */
	replyBeforeUnfinishedStep: Schema.optional(ReplyDraft),
	/** How many model requests the turn has made, one a step. */
	steps: Schema.Int,
	execution: Schema.optional(Schema.Int),
	/** The step the turn last began, so one begun again after a crash is counted. */
	begun: Schema.optional(Schema.Int),
	/** The prompt's size at the turn's first model request. */
	contextTokens: Schema.optional(Schema.Int),
	/** The last step's tool calls, until every one has its result. */
	calls: Schema.Array(StepCall),
	/** The last step's calls that wait for approval. */
	approvals: Schema.Array(CheckpointApproval),
	/** Whether the turn has waited for approvals, which members gave for this run of it. */
	waited: Schema.optional(Schema.Boolean),
	/** Whether the last step's model request answered without calling a tool. */
	answered: Schema.optional(Schema.Boolean),
	/** The steers the turn's model requests have read, by message id, in the order read. */
	steersRead: Schema.optional(Schema.Array(Schema.String)),
	/** The approvals the turn waited for that its asker's steer withdrew, by approval id. */
	withdrawnApprovals: Schema.optional(Schema.Array(Schema.String)),
});
export type TurnCheckpoint = typeof TurnCheckpoint.Type;

const emptyCheckpoint: Readonly<TurnCheckpoint> = {
	messages: [],
	reply: emptyReply,
	steps: 0,
	calls: [],
	approvals: [],
};

/** What beginning a step found: what it continues from, that the turn still waits, or that it ended. */
type BegunStep =
	| {
			readonly _tag: "Begun";
			readonly reply: ReplyTurn;
			/** Where the turn left off; none before its first step. */
			readonly checkpoint: TurnCheckpoint | undefined;
	  }
	| { readonly _tag: "Waiting"; readonly approvals: readonly string[] }
	| { readonly _tag: "Ended" };

/** What a step's model request recorded. */
interface RecordedModelRequest {
	/** The prompt, which a turn keeps from its first step on. */
	readonly modelInput: ModelInput;
	/** What the model answered with: its text, thinking and tool calls. */
	readonly messages: readonly ModelMessage[];
	/** The steers the request read first, by message id, and as it read them; none when absent. */
	readonly steers?: { readonly ids: readonly string[]; readonly messages: readonly ModelMessage[] };
	/** The reply with the step's text. */
	readonly reply: ReplyDraft;
	readonly contextTokens: number | undefined;
	/** The tool calls the model made, each waiting for its result. */
	readonly calls: ReadonlyArray<Pick<StepCall, "toolCallId" | "toolName" | "input">>;
	/**
	 * Whether the request was the turn's last: its calls are never made, so
	 * the step stands as the turn's answer, and a step taken again ends it.
	 */
	readonly last: boolean;
}

/** What the model is given back for one of the last step's tool calls. */
interface StepCallResult {
	readonly toolCallId: string;
	readonly output: ToolResultPart["output"];
}

/** The tool message giving the model back what each of a step's calls returned, in the order it made them. */
function toolMessage(calls: readonly StepCall[]): ToolModelMessage {
	return {
		role: "tool",
		content: calls.map(
			(call): ToolResultPart => ({
				type: "tool-result",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				output: call.result ?? { type: "error-text", value: "The tool gave no result." },
			}),
		),
	};
}

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
	/** Whether steers no step read start a turn of their own, as when the turn may take no more steps. */
	readonly handsOnUnreadSteers?: boolean;
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
	endRequested: turn.endRequested,
	runs: turn.runs,
	writeOrDeleteStarted: turn.writeOrDeleteStarted,
	error: turn.error,
	retrying: turn.retrying,
	waited: sql<boolean>`coalesce((${turn.checkpoint} ->> 'waited')::boolean, false)`,
};

function stateOf(row: {
	status: TurnState["status"];
	executionId: string | null;
	endRequested: TurnEndRequest | null;
	runs: number;
	writeOrDeleteStarted: boolean;
	error: UserText | null;
	retrying: boolean;
	waited: boolean;
}): TurnState {
	const facts = {
		executionId: row.executionId,
		endRequested: row.endRequested,
		runs: row.runs,
		waited: row.waited,
		writeOrDeleteStarted: row.writeOrDeleteStarted,
	};
	if (row.status !== "failed") return { ...facts, status: row.status };
	if (row.error === null) throw new Error("A failed turn has no error, which the schema forbids");
	return { ...facts, status: "failed", userMessage: row.error, retrying: row.retrying };
}

/**
 * Locks the turn found by `condition`, and reads its state and bot.
 *
 * Every transaction that works on turns takes its locks in one order, so
 * none waits on another in a cycle:
 *
 * 1. An automation run's settlement lock (`lockAutomationSettlement`), which
 *    settling the run takes before it ends the run's turns (`cancelUnder`),
 *    and admitting work into the run before it opens a turn.
 * 2. The workspace's row: `FOR SHARE` to park calls for approval, ordered
 *    with deletion, which holds the row `FOR NO KEY UPDATE` until it has
 *    withdrawn approvals for the work it deletes.
 * 3. Each bot's turns, bot by bot in bot-id order: the opening of the bot's
 *    turns in the chat (`lockOpening`), then its turn rows in turn-id order.
 *    A tool call's row is locked only while its turn's row is held, so it
 *    never waits in a cycle itself.
 * 4. The bot's message a hand-back answers, which `FloorControl` locks
 *    (`handBackIfOwed`) before asking for the hand-back, so of two helpers'
 *    turns ending at once, the second sees the first's end.
 * 5. Lanes, in bot-id order.
 *
 * A transaction may skip a level but never go back to an earlier one. A lock
 * taken with `SKIP LOCKED` never waits, so it may come in any order. A steer
 * takes each bot's opening and active turns' rows, withdrawing a waiting
 * turn's calls, and then asks for turns in the bots' lanes; deciding,
 * withdrawing and expiring an approval take the turn's row and then its
 * calls; ending or interrupting a turn takes its row, then its calls, then
 * the lane of any turn it hands its unread steers on to; and granting a lane
 * takes only lanes.
 */
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
	return { _tag: "NotRunnable", reason, ended, endedBefore: false };
}

/** How members are told a turn ended mid-run. */
function endAnnouncement(
	reply: {
		turnId: string;
		chatId: string;
		workspaceId: string;
		botId: string;
		messageId: string;
		execution: number;
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
				execution: reply.execution,
				userMessage: ended.error,
				willRetry: false,
			})
		: ChatEvent.TurnInterrupted(reply);
}

function replyForRestart(checkpoint: TurnCheckpoint): ReplyDraft {
	if (checkpoint.replyBeforeUnfinishedStep) return checkpoint.replyBeforeUnfinishedStep;
	const { reply, steps, messages } = checkpoint;
	const thinking = reply.thinking?.filter((part) => part.step < steps);
	if (thinking?.length === reply.thinking?.length) return reply;

	// A checkpoint without a completed draft can still have an unfinished
	// thinking entry. Its transcript only covers completed model requests.
	const committedText = messages
		.flatMap((message) => {
			if (message.role !== "assistant") return [];
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		})
		.join("");
	return {
		...reply,
		content: reply.content.startsWith(committedText) ? committedText : reply.content,
		thinking,
	};
}

/** The stored parts of a reply: its text, split around the tool calls it made. */
function replyParts(reply: ReplyDraft): StoredMessagePart[] {
	const placed = reply.toolCalls.map(({ id, atOffset }) => ({
		type: "tool_call" as const,
		toolCallId: id,
		atOffset,
	}));
	const parts = messagePartsFor(reply.content, placed)
		.map(
			(part): StoredMessagePart =>
				part.type === "text" ? part : { type: "tool_call", toolCallId: part.toolCallId },
		)
		.filter((part) => part.type !== "text" || part.text !== "");
	return [
		...parts,
		...(reply.thinking ?? []).map((part) => ({ ...part, type: "thinking" as const })),
	];
}

/** recordTurnProjectGrant saves newly gained reach in the transaction that grants it. */
export const recordTurnProjectGrant = (principal: Principal, projectId: string) =>
	Effect.gen(function* () {
		if (
			principal._tag !== "BotForAsker" ||
			principal.bounds.kind !== "member" ||
			!principal.admission
		)
			return;
		yield* Transaction;
		const admitted: AdmittedProject = {
			project: { defaultOf: null },
			inProject: true,
			memberReaches: true,
			botReaches: true,
		};
		yield* query((db) =>
			db
				.update(turn)
				.set({
					admission: sql`jsonb_set(${turn.admission}, '{projectGrants}',
						coalesce(${turn.admission} -> 'projectGrants', '{}'::jsonb)
						|| jsonb_build_object(${projectId}::text, ${JSON.stringify(admitted)}::jsonb))`,
				})
				.where(fenced(executionFence(principal.turn, principal.executionNumber))),
		);
	});

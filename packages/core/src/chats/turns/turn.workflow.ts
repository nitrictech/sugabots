/**
 * A bot's turn, as a durable workflow: its definition and the order of its
 * steps. What each step does lives behind `TurnSteps`, implemented in
 * `turn.steps.ts`.
 *
 * A turn runs in segments. Each segment streams the reply until it ends or
 * stops to wait for tool approvals; the workflow then waits, durably, for
 * members to decide them, and runs the next segment from the checkpoint,
 * which reads the decisions recorded as they were made.
 */
import { Activities } from "@sugabots/workflow/activities";
import { and, sql } from "drizzle-orm";
import { Context, Duration, Effect, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";
import type { TurnReason } from "../sql.ts";
import { ApprovalDecision, DecidedApproval } from "./tool-calls/lifecycle.ts";

/** The turn a workflow carries out, as its payload: which bot answers which message in which chat, and why. */
export const TurnRequest = Schema.Struct({
	chatId: Schema.String,
	botId: Schema.String,
	triggerMessageId: Schema.String,
	reason: Schema.Literals([
		"mention",
		"reply",
		"default",
		"optional",
		"collaboration",
		"automation",
		"hand_back",
		"interview",
		"brief",
	]) satisfies Schema.Codec<TurnReason>,
});
export type TurnRequest = typeof TurnRequest.Type;

/** A turn is one bot answering one message, so that is what identifies its execution. */
export const Turn = Workflow.make("turn", {
	payload: TurnRequest,
	idempotencyKey: (request) => `${request.chatId}/${request.botId}/${request.triggerMessageId}`,
});

/** One turn per bot per chat at a time; the turn reads everything posted while it waited. */
export const turnLane = (request: Pick<TurnRequest, "chatId" | "botId">) =>
	`turn:${request.chatId}:${request.botId}`;

/**
 * Whether a turn for `reason` answers its own message alone: a helper's,
 * asked by another bot's message, and a hand-back, asked once the helpers are
 * done. Such a turn never joins another waiting for its bot, and nothing joins
 * it, so a member's message can't make a helper the bot answering a member.
 */
export const answersAlone = (reason: TurnReason): boolean =>
	reason === "collaboration" || reason === "hand_back";

/**
 * Asks for the turn in its lane, joining the caller's transaction, and says
 * whether it started or waits. A turn already waiting is kept, and this one
 * joins it, as it will read every message posted since; unless either answers
 * its own message alone (see `answersAlone`), when this one waits behind it.
 */
export const admitTurn = (lanes: Lanes.Interface, request: TurnRequest) =>
	lanes.admit({
		key: turnLane(request),
		subject: request.chatId,
		workflow: Turn,
		payload: request,
		whenBusy: answersAlone(request.reason) ? "queue" : "coalesce",
		joins: (waiting) => !answersAlone(waiting.reason),
	});

/**
 * Whether the lanes of the chat `chatId` hold a turn for `reason` on the
 * message `triggerMessageId`, not yet started, running, or ended with its lane
 * not yet free; other than `exceptBotId`'s, when given. As a condition for a
 * query.
 */
export const heldInLane = (
	chatId: string,
	turn: { triggerMessageId: string; reason: TurnReason; exceptBotId?: string },
) =>
	// Every field of a `TurnRequest` is a string, so its JSON encoding names them as it does.
	Lanes.holdsRequest(sql`${chatId}`, Turn._tag, (payload) =>
		and(
			sql`${payload}->>'triggerMessageId' = ${turn.triggerMessageId}`,
			sql`${payload}->>'reason' = ${turn.reason}`,
			turn.exceptBotId === undefined ? undefined : sql`${payload}->>'botId' <> ${turn.exceptBotId}`,
		),
	);

/**
 * How a segment ended: the turn is over, it waits for approvals, or it failed
 * and is recorded as a turn that runs again.
 */
export const SegmentOutcome = Schema.Union([
	Schema.TaggedStruct("Finished", {}),
	Schema.TaggedStruct("Suspended", {
		/** The approvals the turn waits for, each decided through `approvalDecided`. */
		approvals: Schema.Array(Schema.String),
	}),
	Schema.TaggedStruct("Retry", {
		/** How long the provider asked to be left, when it said; the turn waits at least `RETRY_DELAY`. */
		after: Schema.optional(Schema.DurationFromMillis),
	}).pipe(Schema.encodeKeys({ after: "afterMillis" })),
]);
export type SegmentOutcome = typeof SegmentOutcome.Type;

/**
 * A member's decision on one approval. It is sent in the transaction that
 * records it (see `Turns.Controls`), so the two commit or roll back together.
 */
export const approvalDecided = (approvalId: string) =>
	DurableDeferred.make(`approval/${approvalId}`, { success: ApprovalDecision });

/** The turn was cancelled while it waited for approvals, because its automation run ended. */
export const interruptRequested = DurableDeferred.make("interrupted");

export class TurnSteps extends Context.Service<
	TurnSteps,
	{
		/** Runs the turn from where it stands until it ends, waits for approvals, or fails and may run again. */
		readonly segment: (turn: TurnRequest) => Effect.Effect<SegmentOutcome>;
		/** Records the waiting turn as cancelled. Does nothing if it is no longer waiting. */
		readonly cancelWaiting: (turn: TurnRequest) => Effect.Effect<void>;
		/** Ends the turn as failed when its workflow fails. */
		readonly abandon: (turn: TurnRequest) => Effect.Effect<void>;
		/**
		 * Announces that the turn's lane is free. An automation run cannot settle
		 * while any of its lanes is busy, so this may let it.
		 */
		readonly announceReleased: (turn: TurnRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/TurnSteps") {}

/** Each run of a segment is a separate activity, numbered from 0 within the execution. */
const turnActivities = Activities.fromService<TurnRequest>()(TurnSteps, {
	segment: { input: Schema.Int, success: SegmentOutcome },
	cancelWaiting: {},
	abandon: {},
	announceReleased: {},
});

/** How long a turn waits after a failed segment before running again. */
const RETRY_DELAY = Duration.seconds(2);

export const turnWorkflow = Lanes.workflow(Turn, {
	lane: turnLane,
	activities: turnActivities,
	body: (request) =>
		Effect.gen(function* () {
			for (let run = 0; ; run++) {
				const outcome = yield* turnActivities.activity("segment", request, run);
				if (outcome._tag === "Finished") return;
				if (outcome._tag === "Retry") {
					yield* DurableClock.sleep({
						name: `retry/${run}`,
						duration: Duration.max(RETRY_DELAY, outcome.after ?? Duration.zero),
					});
					continue;
				}
				const cancelled = yield* waitForApprovals(run, outcome.approvals);
				if (cancelled) return yield* turnActivities.activity("cancelWaiting", request);
			}
		}),
	onFailure: "abandon",
	onReleased: "announceReleased",
});

const Awaited = Schema.Union([Schema.Literal("cancelled"), DecidedApproval]);

/**
 * Waits for every approval still outstanding (or a cancel), in whatever order
 * members decide them, by racing them. The race's winner is stored, so a replay
 * takes the same path. Returns whether the turn was cancelled instead.
 */
const waitForApprovals = (run: number, approvals: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		let outstanding = approvals;
		for (let round = 0; outstanding.length > 0; round++) {
			const next = yield* DurableDeferred.raceAll({
				name: `approvals/${run}/${round}`,
				success: Awaited,
				error: Schema.Never,
				effects: [
					Effect.as(DurableDeferred.await(interruptRequested), "cancelled" as const),
					...outstanding.map((approvalId) =>
						Effect.map(DurableDeferred.await(approvalDecided(approvalId)), (decision) => ({
							approvalId,
							decision,
						})),
					),
				],
			});
			if (next === "cancelled") return true;
			outstanding = outstanding.filter((approvalId) => approvalId !== next.approvalId);
		}
		return false;
	});

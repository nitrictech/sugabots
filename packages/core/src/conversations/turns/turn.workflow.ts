/**
 * An agent's turn, as a durable workflow: its definition and the order of its
 * steps. What each step does lives behind `TurnSteps`, implemented in
 * `turn.steps.ts`.
 *
 * A turn runs in segments. Each segment streams the reply until it ends or
 * stops to wait for tool approvals; the workflow then waits, durably, for
 * people to decide them, records each decision, and runs the next segment
 * from the checkpoint.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Duration, Effect, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";
import type { TurnReason } from "../sql.ts";
import { ApprovalDecision, DecidedApproval } from "../tools/calls/lifecycle.ts";

export const TurnRequest = Schema.Struct({
	threadId: Schema.String,
	agentId: Schema.String,
	triggerMessageId: Schema.String,
	reason: Schema.Literals([
		"mention",
		"facilitator",
		"default",
		"collaboration",
		"routine",
		"resume",
	]) satisfies Schema.Codec<TurnReason>,
});
export type TurnRequest = typeof TurnRequest.Type;

/** A turn is one agent answering one message, so that is what identifies its execution. */
export const Turn = Workflow.make("turn", {
	payload: TurnRequest,
	idempotencyKey: (request) => `${request.threadId}/${request.agentId}/${request.triggerMessageId}`,
});

/** One turn per agent per thread at a time; the turn reads everything posted while it waited. */
export const turnLane = (request: Pick<TurnRequest, "threadId" | "agentId">) =>
	`turn:${request.threadId}:${request.agentId}`;

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
	Schema.TaggedStruct("Retry", {}),
]);
export type SegmentOutcome = typeof SegmentOutcome.Type;

/**
 * A person's decision on one approval. Sending it is the decision: the
 * workflow records it, and the first decision sent is the one that stands.
 */
export const approvalDecided = (approvalId: string) =>
	DurableDeferred.make(`approval/${approvalId}`, { success: ApprovalDecision });

/** A person cancelled the turn while it waited for approvals. */
export const cancelRequested = DurableDeferred.make("cancelled");

export class TurnSteps extends Context.Service<
	TurnSteps,
	{
		/** Runs the turn from where it stands until it ends, waits for approvals, or fails and may run again. */
		readonly segment: (request: TurnRequest) => Effect.Effect<SegmentOutcome>;
		/** Records a decision on one of the turn's approvals. Recording one already decided does nothing. */
		readonly decide: (request: TurnRequest, decided: DecidedApproval) => Effect.Effect<void>;
		/** Records the waiting turn as cancelled. Does nothing if it is no longer waiting. */
		readonly stopWaiting: (request: TurnRequest) => Effect.Effect<void>;
		/** Ends the turn as failed, and its routine run with it, when its workflow fails. */
		readonly abandon: (request: TurnRequest) => Effect.Effect<void>;
		/** Settles the thread's routine run if the turn was its last work; it cannot settle while the turn holds its lane. */
		readonly settleRoutine: (request: TurnRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/TurnSteps") {}

/** Each run of a segment is a separate activity, numbered from 0 within the execution. */
export const turnActivities = Activities.fromService<TurnRequest>()(TurnSteps, {
	segment: { input: Schema.Int, success: SegmentOutcome },
	decide: { input: DecidedApproval },
	stopWaiting: {},
	abandon: {},
	settleRoutine: {},
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
					yield* DurableClock.sleep({ name: `retry/${run}`, duration: RETRY_DELAY });
					continue;
				}
				const cancelled = yield* waitForApprovals(request, run, outcome.approvals);
				if (cancelled) return yield* turnActivities.activity("stopWaiting", request);
			}
		}),
	onFailure: "abandon",
	onReleased: "settleRoutine",
});

const Awaited = Schema.Union([Schema.Literal("cancelled"), DecidedApproval]);

/**
 * Records each decision as it arrives, in whatever order people make them, by
 * racing every approval still outstanding (and a cancel). The race's winner is
 * stored, so a replay takes the same path. Returns whether the turn was
 * cancelled instead.
 */
const waitForApprovals = (request: TurnRequest, run: number, approvals: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		let outstanding = approvals;
		for (let round = 0; outstanding.length > 0; round++) {
			const next = yield* DurableDeferred.raceAll({
				name: `approvals/${run}/${round}`,
				success: Awaited,
				error: Schema.Never,
				effects: [
					Effect.as(DurableDeferred.await(cancelRequested), "cancelled" as const),
					...outstanding.map((approvalId) =>
						Effect.map(DurableDeferred.await(approvalDecided(approvalId)), (decision) => ({
							approvalId,
							decision,
						})),
					),
				],
			});
			if (next === "cancelled") return true;
			yield* turnActivities.activity("decide", request, next);
			outstanding = outstanding.filter((approvalId) => approvalId !== next.approvalId);
		}
		return false;
	});

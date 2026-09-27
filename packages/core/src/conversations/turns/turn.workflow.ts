/**
 * An agent's turn, as a durable workflow. It holds only the definition: what
 * each step does lives behind `TurnSteps`, implemented in `worker.ts`.
 *
 * A turn runs in segments. Each segment streams the reply until it ends or
 * stops to wait for tool approvals; the workflow then waits, durably, for
 * people to decide them, records each decision, and runs the next segment
 * from the checkpoint.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Duration, Effect, Exit, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import type { TurnReason } from "../sql.ts";

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

/** How a segment ended: the turn is over, it waits for approvals, or it failed and runs again. */
export const SegmentOutcome = Schema.Union([
	Schema.TaggedStruct("Finished", {}),
	Schema.TaggedStruct("Suspended", {
		/** The approvals the turn waits for, each decided through `approvalDecided`. */
		approvals: Schema.Array(Schema.String),
	}),
	Schema.TaggedStruct("Retry", {}),
]);
export type SegmentOutcome = typeof SegmentOutcome.Type;

export const ApprovalDecision = Schema.Struct({
	decision: Schema.Literals(["allow_once", "deny"]),
	userId: Schema.String,
});
export type ApprovalDecision = typeof ApprovalDecision.Type;

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
		/** Runs the turn from where it stands until it ends or waits. `attempt` counts failed runs, plus one. */
		readonly segment: (request: TurnRequest, attempt: number) => Effect.Effect<SegmentOutcome>;
		/** Records a decision on one of the turn's approvals. Recording one already decided does nothing. */
		readonly decide: (
			request: TurnRequest,
			approvalId: string,
			decision: ApprovalDecision,
		) => Effect.Effect<void>;
		/** Records the waiting turn as cancelled. Does nothing if it is no longer waiting. */
		readonly stopWaiting: (request: TurnRequest) => Effect.Effect<void>;
		/** Ends the turn as failed when its workflow fails outside a segment. */
		readonly abandon: (request: TurnRequest) => Effect.Effect<void>;
		/** Frees the turn's lane for the next request. */
		readonly release: (request: TurnRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/TurnSteps") {}

/**
 * An activity is rebuilt from its name and the payload alone, so what varies
 * goes in its key: a segment's is `run.attempt`, and a decision's is
 * `approvalId/decision/userId`.
 */
const segmentKey = (run: number, attempt: number) => `${run}.${attempt}`;
const attemptOf = (key: string) => Number(key.slice(key.indexOf(".") + 1));
const decisionKey = (approvalId: string, decision: ApprovalDecision) =>
	`${approvalId}/${decision.decision}/${decision.userId}`;
const decisionOf = (key: string) => {
	const [userId = "", decision, ...approvalId] = key.split("/").reverse();
	return {
		approvalId: approvalId.reverse().join("/"),
		decision: Schema.decodeUnknownSync(ApprovalDecision)({ decision, userId }),
	};
};

export const turnActivities = Activities.make<TurnRequest>()({
	segment: {
		success: SegmentOutcome,
		execute: (request, key) =>
			Effect.flatMap(Effect.service(TurnSteps), (steps) => steps.segment(request, attemptOf(key))),
	},
	decide: {
		execute: (request, key) =>
			Effect.flatMap(Effect.service(TurnSteps), (steps) => {
				const decided = decisionOf(key);
				return steps.decide(request, decided.approvalId, decided.decision);
			}),
	},
	stopWaiting: {
		execute: (request) =>
			Effect.flatMap(Effect.service(TurnSteps), (steps) => steps.stopWaiting(request)),
	},
	abandon: {
		execute: (request) =>
			Effect.flatMap(Effect.service(TurnSteps), (steps) => steps.abandon(request)),
	},
	release: {
		execute: (request) =>
			Effect.flatMap(Effect.service(TurnSteps), (steps) => steps.release(request)),
	},
});

/**
 * Whatever happens to the turn, the lane is released so the next one can run,
 * and a failure ends the turn rather than leaving it running or waiting. A
 * suspension surfaces here as an interruption, but the turn is not over, so
 * it passes through untouched.
 */
export const turnWorkflow = (request: TurnRequest) =>
	Effect.gen(function* () {
		const ended = yield* Effect.exit(segments(request));
		const instance = yield* WorkflowEngine.WorkflowInstance;
		if (instance.suspended) return yield* ended;
		if (Exit.isFailure(ended)) yield* turnActivities.activity("abandon", request);
		yield* turnActivities.activity("release", request);
	});

/** How long to wait before running a failed segment again, doubling each time. */
const retryDelay = (attempt: number) => Duration.seconds(2 ** (attempt - 2));

const segments = (request: TurnRequest) =>
	Effect.gen(function* () {
		let attempt = 1;
		for (let run = 0; ; run++) {
			const outcome = yield* turnActivities.activity("segment", request, segmentKey(run, attempt));
			if (outcome._tag === "Finished") return;
			if (outcome._tag === "Retry") {
				attempt++;
				yield* DurableClock.sleep({ name: `retry/${run}`, duration: retryDelay(attempt) });
			}
			if (outcome._tag === "Suspended") {
				const cancelled = yield* waitForApprovals(request, run, outcome.approvals);
				if (cancelled) return yield* turnActivities.activity("stopWaiting", request);
			}
		}
	});

const Awaited = Schema.Union([
	Schema.Literal("cancelled"),
	Schema.Struct({ approvalId: Schema.String, decision: ApprovalDecision }),
]);

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
			yield* turnActivities.activity(
				"decide",
				request,
				decisionKey(next.approvalId, next.decision),
			);
			outstanding = outstanding.filter((approvalId) => approvalId !== next.approvalId);
		}
		return false;
	});

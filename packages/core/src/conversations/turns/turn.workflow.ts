/**
 * An agent's turn, as a durable workflow. It holds only the definition: what
 * each step does lives behind `TurnSteps`, implemented in `worker.ts`.
 *
 * A turn runs in segments. Each segment streams the reply until it ends or
 * stops to wait for tool approvals; the workflow then waits, durably, for the
 * approvals to be decided and runs the next segment from the checkpoint.
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
		/** Names the batch of approvals the turn waits for; see `approvalsDecided`. */
		approvals: Schema.String,
	}),
	Schema.TaggedStruct("Retry", {}),
]);
export type SegmentOutcome = typeof SegmentOutcome.Type;

/** Completed once every approval in the batch is decided, which resumes the turn. */
export const approvalsDecided = (approvals: string) =>
	DurableDeferred.make(`approvals/${approvals}`);

export class TurnSteps extends Context.Service<
	TurnSteps,
	{
		/** Runs the turn from where it stands until it ends or waits. `attempt` counts failed runs, plus one. */
		readonly segment: (request: TurnRequest, attempt: number) => Effect.Effect<SegmentOutcome>;
		/** Ends the turn as failed when its workflow fails outside a segment. */
		readonly abandon: (request: TurnRequest) => Effect.Effect<void>;
		/** Frees the turn's lane for the next request. */
		readonly release: (request: TurnRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/TurnSteps") {}

/** A segment's key is `run.attempt`; the attempt is in the key so the activity can be rebuilt from its name. */
const segmentKey = (run: number, attempt: number) => `${run}.${attempt}`;
const attemptOf = (key: string) => Number(key.slice(key.indexOf(".") + 1));

export const turnActivities = Activities.make<TurnRequest>()({
	segment: {
		success: SegmentOutcome,
		execute: (request, key) =>
			Effect.flatMap(Effect.service(TurnSteps), (steps) => steps.segment(request, attemptOf(key))),
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
export const turn = (request: TurnRequest) =>
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
				yield* DurableDeferred.await(approvalsDecided(outcome.approvals));
			}
		}
	});

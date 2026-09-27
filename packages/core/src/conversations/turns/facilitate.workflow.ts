/**
 * Facilitating a thread, as a durable workflow: deciding who speaks after a
 * message (ADR 004). It holds only the definition: what each step does lives
 * behind `FacilitateSteps`, implemented in `facilitator.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Duration, Effect, Exit, Schema } from "effect";
import { DurableClock, Workflow, WorkflowEngine } from "effect/unstable/workflow";

export const FacilitateRequest = Schema.Struct({
	threadId: Schema.String,
	/** The message the facilitator decides the next speaker after. */
	triggerMessageId: Schema.String,
});
export type FacilitateRequest = typeof FacilitateRequest.Type;

export const Facilitate = Workflow.make("facilitate", {
	payload: FacilitateRequest,
	idempotencyKey: (request) => `${request.threadId}/${request.triggerMessageId}`,
});

/** One facilitation per thread at a time; a newer request replaces one still waiting. */
export const facilitateLane = (threadId: string) => `facilitate:${threadId}`;

/** How an attempt ended: the floor is decided, or the attempt failed and runs again. */
export const AttemptOutcome = Schema.Literals(["finished", "retry"]);
export type AttemptOutcome = typeof AttemptOutcome.Type;

export class FacilitateSteps extends Context.Service<
	FacilitateSteps,
	{
		/**
		 * Decides who speaks next and gives them the floor. `attempt` counts
		 * failed attempts, plus one; the last one settles the thread's routine as
		 * failed instead of asking to run again.
		 */
		readonly attempt: (
			request: FacilitateRequest,
			attempt: number,
		) => Effect.Effect<AttemptOutcome>;
		/** Settles the thread's routine as failed when the workflow fails outside an attempt. */
		readonly abandon: (request: FacilitateRequest) => Effect.Effect<void>;
		/** Frees the thread's facilitation lane for the next request. */
		readonly release: (request: FacilitateRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/FacilitateSteps") {}

/** An attempt is rebuilt from its name and the payload alone, so its key is its number. */
export const facilitateActivities = Activities.make<FacilitateRequest>()({
	attempt: {
		success: AttemptOutcome,
		execute: (request, key) =>
			Effect.flatMap(Effect.service(FacilitateSteps), (steps) =>
				steps.attempt(request, Number(key)),
			),
	},
	abandon: {
		execute: (request) =>
			Effect.flatMap(Effect.service(FacilitateSteps), (steps) => steps.abandon(request)),
	},
	release: {
		execute: (request) =>
			Effect.flatMap(Effect.service(FacilitateSteps), (steps) => steps.release(request)),
	},
});

/**
 * Whatever happens, the lane is released so the next request can run. A
 * suspension, while waiting out a retry's delay, surfaces here as an
 * interruption, but the facilitation is not over, so it passes through.
 */
export const facilitate = (request: FacilitateRequest) =>
	Effect.gen(function* () {
		const ended = yield* Effect.exit(attempts(request));
		const instance = yield* WorkflowEngine.WorkflowInstance;
		if (instance.suspended) return yield* ended;
		if (Exit.isFailure(ended)) yield* facilitateActivities.activity("abandon", request);
		yield* facilitateActivities.activity("release", request);
	});

/** How long to wait after a failed attempt before the next: one second, then two. */
const retryDelay = (failedAttempt: number) => Duration.seconds(2 ** (failedAttempt - 1));

const attempts = (request: FacilitateRequest) =>
	Effect.gen(function* () {
		for (let attempt = 1; ; attempt++) {
			const outcome = yield* facilitateActivities.activity("attempt", request, attempt);
			if (outcome === "finished") return;
			yield* DurableClock.sleep({ name: `retry/${attempt}`, duration: retryDelay(attempt) });
		}
	});

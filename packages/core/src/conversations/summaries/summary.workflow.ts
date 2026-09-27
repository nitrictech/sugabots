/**
 * Summarising a thread, as a durable workflow. It holds only the definition:
 * what each step does lives behind `SummarySteps`, implemented in `worker.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Effect, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";

export const SummaryRequest = Schema.Struct({
	threadId: Schema.String,
	/** The agent whose turn prompted the summary. */
	agentId: Schema.String,
	/** The last message the summary covers. */
	sourceMessageId: Schema.String,
});
export type SummaryRequest = typeof SummaryRequest.Type;

export const Summary = Workflow.make("summary", {
	payload: SummaryRequest,
	idempotencyKey: (request) => `${request.threadId}/${request.sourceMessageId}`,
});

/** One summary per thread at a time; a newer request replaces one still waiting. */
export const summaryLane = (threadId: string) => `summary:${threadId}`;

export class SummarySteps extends Context.Service<
	SummarySteps,
	{
		/** Prepares, generates and records the summary, or does nothing if it is no longer needed. */
		readonly summarise: (request: SummaryRequest) => Effect.Effect<void>;
		/** Frees the thread's summary lane for the next request. */
		readonly release: (request: SummaryRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/SummarySteps") {}

export const summaryActivities = Activities.make<SummaryRequest>()({
	summarise: {
		execute: (request) =>
			Effect.flatMap(Effect.service(SummarySteps), (steps) => steps.summarise(request)),
	},
	release: {
		execute: (request) =>
			Effect.flatMap(Effect.service(SummarySteps), (steps) => steps.release(request)),
	},
});

/** Whatever happens to the summary, the lane is released so the next one can run. */
export const summary = (request: SummaryRequest) =>
	Effect.andThen(
		Effect.exit(summaryActivities.activity("summarise", request)),
		summaryActivities.activity("release", request),
	);

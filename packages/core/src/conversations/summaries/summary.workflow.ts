/**
 * Summarising a thread, as a durable workflow: its definition and its step.
 * What the step does lives behind `SummarySteps`, implemented in
 * `summary.steps.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, type Effect, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

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
export const summaryLane = (request: Pick<SummaryRequest, "threadId">) =>
	`summary:${request.threadId}`;

export class SummarySteps extends Context.Service<
	SummarySteps,
	{
		/** Prepares, generates and records the summary, or does nothing if it is no longer needed. */
		readonly summarise: (request: SummaryRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/SummarySteps") {}

export const summaryActivities = Activities.fromService<SummaryRequest>()(SummarySteps, {
	summarise: {},
});

export const summaryWorkflow = Lanes.workflow(Summary, {
	lane: summaryLane,
	activities: summaryActivities,
	body: (request) => summaryActivities.activity("summarise", request),
});

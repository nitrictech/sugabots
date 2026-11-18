/**
 * Summarising a conversation, as a durable workflow: its definition and its step.
 * What the step does lives behind `SummarySteps`, implemented in
 * `summary.steps.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Effect, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

/**
 * A summary request as its workflow's payload. The workflow engine and the
 * lanes store payloads, so the conversation's and the bot's ids keep the keys
 * the first ones were stored with.
 */
export const StoredSummary = Schema.Struct({
	threadId: Schema.String,
	agentId: Schema.String,
	sourceMessageId: Schema.String,
});
export type StoredSummary = typeof StoredSummary.Type;

export interface SummaryRequest {
	readonly conversationId: string;
	/** The bot whose turn prompted the summary. */
	readonly botId: string;
	/** The last message the summary covers. */
	readonly sourceMessageId: string;
}

const storedSummary = ({ conversationId, botId, ...request }: SummaryRequest): StoredSummary => ({
	...request,
	threadId: conversationId,
	agentId: botId,
});

export const summaryOfStored = (stored: StoredSummary): SummaryRequest => {
	const { agentId, threadId, ...request } = stored;
	return { ...request, conversationId: threadId, botId: agentId };
};

export const Summary = Workflow.make("summary", {
	payload: StoredSummary,
	idempotencyKey: (stored) => `${stored.threadId}/${stored.sourceMessageId}`,
});

/** One summary per conversation at a time; a newer request replaces one still waiting. */
export const summaryLane = (request: Pick<SummaryRequest, "conversationId">) =>
	`summary:${request.conversationId}`;

/**
 * Asks for a summary covering the conversation up to `sourceMessageId`. A
 * request still waiting for it is pointed at this newer message instead.
 */
export const admitSummary = (lanes: Lanes.Interface, request: SummaryRequest) =>
	lanes
		.admit({
			key: summaryLane(request),
			workflow: Summary,
			payload: storedSummary(request),
			whenBusy: "replace",
		})
		.pipe(Effect.asVoid);

export class SummarySteps extends Context.Service<
	SummarySteps,
	{
		/** Prepares, generates and records the summary, or does nothing if it is no longer needed. */
		readonly summarise: (summary: StoredSummary) => Effect.Effect<void>;
	}
>()("@sugabots/core/SummarySteps") {}

const summaryActivities = Activities.fromService<StoredSummary>()(SummarySteps, {
	summarise: {},
});

export const summaryWorkflow = Lanes.workflow(Summary, {
	lane: (stored) => summaryLane(summaryOfStored(stored)),
	activities: summaryActivities,
	body: (request) => summaryActivities.activity("summarise", request),
});

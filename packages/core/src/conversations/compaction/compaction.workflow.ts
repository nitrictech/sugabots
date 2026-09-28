/**
 * Compacting a thread, as a durable workflow: its definition and its step.
 * What the step does lives behind `CompactionSteps`, implemented in
 * `compaction.steps.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, type Effect, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

export const CompactionRequest = Schema.Struct({
	threadId: Schema.String,
	/** The agent whose turn filled the thread past the compaction line. */
	agentId: Schema.String,
	/** That turn's reply: the newest message the compaction considers. */
	sourceMessageId: Schema.String,
	/**
	 * Where the compaction that turn read kept messages from, as an ISO time, or
	 * null if it read none. A turn measured on an older compaction than the
	 * thread's current one says nothing about how full the thread is now.
	 */
	readKeptFrom: Schema.NullOr(Schema.String),
});
export type CompactionRequest = typeof CompactionRequest.Type;

export const Compaction = Workflow.make("compaction", {
	payload: CompactionRequest,
	idempotencyKey: (request) => `${request.threadId}/${request.sourceMessageId}`,
});

/** One compaction per thread at a time; a newer request replaces one still waiting. */
export const compactionLane = (request: Pick<CompactionRequest, "threadId">) =>
	`compaction:${request.threadId}`;

export class CompactionSteps extends Context.Service<
	CompactionSteps,
	{
		/** Prepares, generates and records the compaction, or does nothing if it is not needed. */
		readonly compact: (request: CompactionRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/CompactionSteps") {}

export const compactionActivities = Activities.fromService<CompactionRequest>()(CompactionSteps, {
	compact: {},
});

export const compactionWorkflow = Lanes.workflow(Compaction, {
	lane: compactionLane,
	activities: compactionActivities,
	body: (request) => compactionActivities.activity("compact", request),
});

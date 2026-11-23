/**
 * Compacting a chat, as a durable workflow: its definition and its step.
 * What the step does lives behind `CompactionSteps`, implemented in
 * `compaction.steps.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Effect, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

/** A compaction request, as its workflow's payload. */
export const CompactionRequest = Schema.Struct({
	chatId: Schema.String,
	/** The bot whose turn filled the chat past the compaction line. */
	botId: Schema.String,
	/** That turn's reply: the newest message the compaction considers. */
	sourceMessageId: Schema.String,
	/**
	 * Where the compaction that turn read kept messages from, as an ISO time, or
	 * null if it read none. A turn measured on an older compaction than the
	 * chat's current one says nothing about how full it is now.
	 */
	readKeptFrom: Schema.NullOr(Schema.String),
});
export type CompactionRequest = typeof CompactionRequest.Type;

export const Compaction = Workflow.make("compaction", {
	payload: CompactionRequest,
	idempotencyKey: (request) => `${request.chatId}/${request.sourceMessageId}`,
});

/** One compaction per chat at a time; a newer request replaces one still waiting. */
export const compactionLane = (request: Pick<CompactionRequest, "chatId">) =>
	`compaction:${request.chatId}`;

/**
 * Asks for the chat to be compacted up to `sourceMessageId`. A
 * request still waiting for it is pointed at this newer message instead.
 */
export const admitCompaction = (lanes: Lanes.Interface, request: CompactionRequest) =>
	lanes
		.admit({
			key: compactionLane(request),
			workflow: Compaction,
			payload: request,
			whenBusy: "replace",
		})
		.pipe(Effect.asVoid);

export class CompactionSteps extends Context.Service<
	CompactionSteps,
	{
		/** Prepares, generates and records the compaction, or does nothing if it is not needed. */
		readonly compact: (compaction: CompactionRequest) => Effect.Effect<void>;
	}
>()("@sugabots/core/CompactionSteps") {}

const compactionActivities = Activities.fromService<CompactionRequest>()(CompactionSteps, {
	compact: {},
});

export const compactionWorkflow = Lanes.workflow(Compaction, {
	lane: compactionLane,
	activities: compactionActivities,
	body: (request) => compactionActivities.activity("compact", request),
});

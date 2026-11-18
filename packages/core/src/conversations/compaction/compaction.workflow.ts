/**
 * Compacting a conversation, as a durable workflow: its definition and its step.
 * What the step does lives behind `CompactionSteps`, implemented in
 * `compaction.steps.ts`.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Effect, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

/**
 * A compaction request as its workflow's payload. The workflow engine and the
 * lanes store payloads, so the conversation's and the bot's ids keep the keys
 * the first ones were stored with.
 */
const StoredCompaction = Schema.Struct({
	threadId: Schema.String,
	agentId: Schema.String,
	sourceMessageId: Schema.String,
	readKeptFrom: Schema.NullOr(Schema.String),
});
type StoredCompaction = typeof StoredCompaction.Type;

export interface CompactionRequest {
	readonly conversationId: string;
	/** The bot whose turn filled the conversation past the compaction line. */
	readonly botId: string;
	/** That turn's reply: the newest message the compaction considers. */
	readonly sourceMessageId: string;
	/**
	 * Where the compaction that turn read kept messages from, as an ISO time, or
	 * null if it read none. A turn measured on an older compaction than the
	 * conversation's current one says nothing about how full it is now.
	 */
	readonly readKeptFrom: string | null;
}

const storedCompaction = ({
	conversationId,
	botId,
	...request
}: CompactionRequest): StoredCompaction => ({
	...request,
	threadId: conversationId,
	agentId: botId,
});

export const compactionOfStored = (stored: StoredCompaction): CompactionRequest => {
	const { agentId, threadId, ...request } = stored;
	return { ...request, conversationId: threadId, botId: agentId };
};

export const Compaction = Workflow.make("compaction", {
	payload: StoredCompaction,
	idempotencyKey: (stored) => `${stored.threadId}/${stored.sourceMessageId}`,
});

/** One compaction per conversation at a time; a newer request replaces one still waiting. */
export const compactionLane = (request: Pick<CompactionRequest, "conversationId">) =>
	`compaction:${request.conversationId}`;

/**
 * Asks for the conversation to be compacted up to `sourceMessageId`. A
 * request still waiting for it is pointed at this newer message instead.
 */
export const admitCompaction = (lanes: Lanes.Interface, request: CompactionRequest) =>
	lanes
		.admit({
			key: compactionLane(request),
			workflow: Compaction,
			payload: storedCompaction(request),
			whenBusy: "replace",
		})
		.pipe(Effect.asVoid);

export class CompactionSteps extends Context.Service<
	CompactionSteps,
	{
		/** Prepares, generates and records the compaction, or does nothing if it is not needed. */
		readonly compact: (compaction: StoredCompaction) => Effect.Effect<void>;
	}
>()("@sugabots/core/CompactionSteps") {}

const compactionActivities = Activities.fromService<StoredCompaction>()(CompactionSteps, {
	compact: {},
});

export const compactionWorkflow = Lanes.workflow(Compaction, {
	lane: (stored) => compactionLane(compactionOfStored(stored)),
	activities: compactionActivities,
	body: (request) => compactionActivities.activity("compact", request),
});

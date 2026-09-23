import type { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { TurnReason } from "../../database/schema.ts";
import { enqueueJob } from "../jobs/queue.ts";

/**
 * Queues an agent's turn for a message, recording why it gets one. A turn
 * already queued for the same agent in the same thread is kept, because it
 * will read every message posted since, including this one.
 */
export const queueTurn = (input: {
	threadId: string;
	agentId: string;
	triggerMessageId: string;
	reason: TurnReason;
}): Effect.Effect<void, never, Database> =>
	enqueueJob({
		kind: "turn",
		threadId: input.threadId,
		payload: {
			agentId: input.agentId,
			triggerMessageId: input.triggerMessageId,
			reason: input.reason,
		},
		dedupeKey: `turn:${input.threadId}:${input.agentId}`,
		ifAlreadyQueued: "keep",
	});

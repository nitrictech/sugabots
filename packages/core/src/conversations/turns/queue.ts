import type { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { TurnReason } from "../../database/schema.ts";
import { enqueueJob } from "../jobs/queue.ts";

/** An agent's turn, asked for because of a message. */
export interface TurnRequest {
	readonly threadId: string;
	readonly agentId: string;
	readonly triggerMessageId: string;
	readonly reason: TurnReason;
}

/**
 * Asks for an agent's turn, in the caller's transaction. A turn already asked
 * for, for the same agent in the same thread, is kept, because it will read
 * every message posted since, including this one. Given to the code that
 * starts turns, so how turns are run can change without it.
 */
export type QueueTurn = (request: TurnRequest) => Effect.Effect<void, never, Database>;

/** Turns as jobs on the job queue. */
export const queueTurnAsJob: QueueTurn = (request) =>
	enqueueJob({
		kind: "turn",
		threadId: request.threadId,
		payload: {
			agentId: request.agentId,
			triggerMessageId: request.triggerMessageId,
			reason: request.reason,
		},
		dedupeKey: `turn:${request.threadId}:${request.agentId}`,
		ifAlreadyQueued: "keep",
	});

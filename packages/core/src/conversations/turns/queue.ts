import { type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { type Lanes, laneBusy } from "../../workflows/lanes.ts";
import { enqueueJob, hasPendingResponseJob } from "../jobs/queue.ts";
import { Turn, type TurnRequest, turnLane } from "./turn.workflow.ts";

/**
 * Asks for an agent's turn, in the caller's transaction. A turn already asked
 * for, for the same agent in the same thread, is kept, because it will read
 * every message posted since, including this one. Given to the code that
 * starts turns, so how turns are run can change without it.
 */
export type QueueTurn = (request: TurnRequest) => Effect.Effect<void, never, Database>;

/** Turns as turn workflows, one at a time per agent per thread. */
export const queueTurnInLane =
	(lanes: Lanes.Interface): QueueTurn =>
	(request) =>
		lanes
			.admit({
				key: turnLane(request),
				subject: request.threadId,
				workflow: Turn,
				payload: request,
				whenBusy: "coalesce",
			})
			.pipe(Effect.asVoid);

/** Turns as jobs on the job queue, before turns ran as workflows. */
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

/**
 * Whether an agent is answering in the thread or about to, as a condition for
 * a query: a turn or facilitation job, or a turn workflow's lane.
 */
export const respondingIn = (threadId: SQL) =>
	sql<boolean>`(${hasPendingResponseJob(threadId)} or ${laneBusy(threadId, [Turn._tag])})`;

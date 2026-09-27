import { type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { type Lanes, laneBusy } from "../../workflows/lanes.ts";
import { hasPendingResponseJob } from "../jobs/queue.ts";
import { Turn, type TurnRequest, turnLane } from "./turn.workflow.ts";

/**
 * Asks for an agent's turn, in the caller's transaction. A turn already asked
 * for, for the same agent in the same thread, is kept, because it will read
 * every message posted since, including this one. Given to the code that
 * starts turns, so how turns are run can change without it.
 */
export type QueueTurn = (request: TurnRequest) => Effect.Effect<void, never, Database>;

/** One turn at a time per agent per thread. */
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

/**
 * Whether an agent is answering in the thread or about to, as a condition for
 * a query: a facilitation job, or a turn workflow's lane.
 */
export const respondingIn = (threadId: SQL) =>
	sql<boolean>`(${hasPendingResponseJob(threadId)} or ${laneBusy(threadId, [Turn._tag])})`;

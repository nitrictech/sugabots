import type { SQL } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { type Lanes, laneBusy } from "../../workflows/lanes.ts";
import { Facilitate, type FacilitateRequest, facilitateLane } from "./facilitate.workflow.ts";
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
 * Asks the facilitator who speaks after a message, in the caller's
 * transaction. Given to the code that gives the floor, like `QueueTurn`.
 */
export type QueueFacilitation = (
	request: FacilitateRequest,
) => Effect.Effect<void, never, Database>;

/**
 * One facilitation at a time per thread. A request for a newer message
 * replaces one still waiting, since only the latest message needs a speaker.
 */
export const queueFacilitationInLane =
	(lanes: Lanes.Interface): QueueFacilitation =>
	(request) =>
		lanes
			.admit({
				key: facilitateLane(request),
				subject: request.threadId,
				workflow: Facilitate,
				payload: request,
				whenBusy: "replace",
			})
			.pipe(Effect.asVoid);

/**
 * Whether an agent is answering in the thread or about to, as a condition for
 * a query: a turn or facilitation workflow's lane.
 */
export const respondingIn = (threadId: SQL) => laneBusy(threadId, [Turn._tag, Facilitate._tag]);

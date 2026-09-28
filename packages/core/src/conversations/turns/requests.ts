export * as TurnRequests from "./requests.ts";

import type { SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Lanes, laneBusy } from "../../workflows/lanes.ts";
import { Summary, type SummaryRequest, summaryLane } from "../summaries/summary.workflow.ts";
import { Facilitate, type FacilitateRequest, facilitateLane } from "./facilitate.workflow.ts";
import { Turn, type TurnRequest, turnLane } from "./turn.workflow.ts";

/**
 * Asks for the work that makes agents speak: their turns, the facilitator's
 * choice of who speaks next, and the Scribe's summaries. Each request joins
 * the caller's transaction, and its workflow starts once that commits.
 */
export interface Interface {
	/**
	 * Asks for an agent's turn. A turn already asked for, for the same agent in
	 * the same thread, is kept, because it will read every message posted
	 * since, including this one.
	 */
	readonly queueTurn: (request: TurnRequest) => Effect.Effect<void>;
	/**
	 * Asks the facilitator who speaks after a message. A request for a newer
	 * message replaces one still waiting, since only the latest message needs a
	 * speaker.
	 */
	readonly queueFacilitation: (request: FacilitateRequest) => Effect.Effect<void>;
	/**
	 * Asks for a summary covering the thread up to `sourceMessageId`. A request
	 * still waiting for the thread is pointed at this newer message instead.
	 */
	readonly queueSummary: (request: SummaryRequest) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnRequests") {}

/** Each kind of work waits in its own lane: turns per agent per thread, the rest per thread. */
export const make = Effect.gen(function* () {
	const lanes = yield* Lanes.Service;
	return Service.of({
		queueTurn: (request) =>
			lanes
				.admit({
					key: turnLane(request),
					subject: request.threadId,
					workflow: Turn,
					payload: request,
					whenBusy: "coalesce",
				})
				.pipe(Effect.asVoid),
		queueFacilitation: (request) =>
			lanes
				.admit({
					key: facilitateLane(request),
					subject: request.threadId,
					workflow: Facilitate,
					payload: request,
					whenBusy: "replace",
				})
				.pipe(Effect.asVoid),
		queueSummary: (request) =>
			lanes
				.admit({
					key: summaryLane(request),
					workflow: Summary,
					payload: request,
					whenBusy: "replace",
				})
				.pipe(Effect.asVoid),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * respondingIn reports, as a condition for a query, whether an agent is
 * answering in the thread `threadId` or about to: a turn or facilitation
 * workflow holds one of its lanes.
 */
export const respondingIn = (threadId: SQL) => laneBusy(threadId, [Turn._tag, Facilitate._tag]);

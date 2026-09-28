export * as TurnRequests from "./requests.ts";

import { Context, Effect, Layer } from "effect";
import { Lanes } from "../../workflows/lanes.ts";
import {
	Compaction,
	type CompactionRequest,
	compactionLane,
} from "../compaction/compaction.workflow.ts";
import { Summary, type SummaryRequest, summaryLane } from "../summaries/summary.workflow.ts";

/**
 * Asks for the system agents' work after a turn: the Scribe's summaries and
 * the Compaction agent's compactions. Each request joins the caller's
 * transaction, and its workflow starts once that commits.
 */
export interface Interface {
	/**
	 * Asks for a summary covering the thread up to `sourceMessageId`. A request
	 * still waiting for the thread is pointed at this newer message instead.
	 */
	readonly queueSummary: (request: SummaryRequest) => Effect.Effect<void>;
	/**
	 * Asks for the thread to be compacted up to `sourceMessageId`. A request
	 * still waiting for the thread is pointed at this newer message instead.
	 */
	readonly queueCompaction: (request: CompactionRequest) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnRequests") {}

/** Each kind of work waits in its own lane, one per thread. */
export const make = Effect.gen(function* () {
	const lanes = yield* Lanes.Service;
	return Service.of({
		queueSummary: (request) =>
			lanes
				.admit({
					key: summaryLane(request),
					workflow: Summary,
					payload: request,
					whenBusy: "replace",
				})
				.pipe(Effect.asVoid),
		queueCompaction: (request) =>
			lanes
				.admit({
					key: compactionLane(request),
					workflow: Compaction,
					payload: request,
					whenBusy: "replace",
				})
				.pipe(Effect.asVoid),
	});
});

export const layer = Layer.effect(Service, make);

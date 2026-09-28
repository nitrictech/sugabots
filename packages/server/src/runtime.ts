import { routineSchedulerLayer } from "@sugabots/core/conversations/routines/scheduler";
import { eventPruningLayer } from "@sugabots/core/database/events/prune";
import type { EventStore } from "@sugabots/core/database/events/store";
import { Layer } from "effect";

/**
 * The background loops that run for as long as the process does: the nightly
 * prune of the durable events in `eventStore`, and the routine scheduler.
 */
export const backgroundLayer = (eventStore: EventStore) =>
	Layer.merge(eventPruningLayer(eventStore), routineSchedulerLayer);

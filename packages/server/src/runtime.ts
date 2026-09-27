import { routineSchedulerLayer } from "@sugabots/core/conversations/routines/scheduler";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import type { Database } from "@sugabots/core/database/database";
import { eventPruningLayer } from "@sugabots/core/database/events/prune";
import type { EventStore } from "@sugabots/core/database/events/store";
import { Layer } from "effect";

/**
 * The background loops that run for as long as the process does.
 *
 * The stores are not here: they are plain objects with no state of their own,
 * built in `index.ts` and handed to whoever needs them.
 */
export interface BackgroundOptions {
	/** Where durable events live, for the nightly prune. */
	eventStore: EventStore;
	routines?: RoutineStore;
}

export function backgroundLayer({
	eventStore,
	routines,
}: BackgroundOptions): Layer.Layer<never, never, Database> {
	return Layer.mergeAll(
		eventPruningLayer(eventStore),
		...(routines ? [routineSchedulerLayer({ store: routines })] : []),
	);
}

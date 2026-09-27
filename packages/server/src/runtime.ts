import { routineDispatcherLayer } from "@sugabots/core/conversations/routines/dispatcher";
import { routineSchedulerLayer } from "@sugabots/core/conversations/routines/scheduler";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import { facilitatorWorkerLayer } from "@sugabots/core/conversations/turns/facilitator";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import type { QueueTurn } from "@sugabots/core/conversations/turns/queue";
import type { Database } from "@sugabots/core/database/database";
import { eventPruningLayer } from "@sugabots/core/database/events/prune";
import type { PublishEvents } from "@sugabots/core/database/events/publish";
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
	model: TurnModel;
	/** How the facilitator asks for the turns it gives the floor to. */
	queueTurn: QueueTurn;
	routines?: RoutineStore;
	/** For the facilitator to announce who it invited. */
	publishEvents: PublishEvents;
}

export function backgroundLayer({
	eventStore,
	model,
	queueTurn,
	routines,
	publishEvents,
}: BackgroundOptions): Layer.Layer<never, never, Database> {
	return Layer.mergeAll(
		eventPruningLayer(eventStore),
		...(routines
			? [routineDispatcherLayer({ store: routines }), routineSchedulerLayer({ store: routines })]
			: []),
		facilitatorWorkerLayer({ model, publishEvents, queueTurn, routines }),
	);
}

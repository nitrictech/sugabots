import { routineDispatcherLayer } from "@sugabots/core/conversations/routines/dispatcher";
import { routineSchedulerLayer } from "@sugabots/core/conversations/routines/scheduler";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import type { SummaryStore } from "@sugabots/core/conversations/summaries/store";
import { summaryWorkerLayer } from "@sugabots/core/conversations/summaries/worker";
import {
	noToolApprovalStore,
	type ToolApprovalStore,
} from "@sugabots/core/conversations/tools/approvals/store";
import type { BuiltInTools } from "@sugabots/core/conversations/tools/built-in";
import type { ToolCallStore } from "@sugabots/core/conversations/tools/calls/store";
import type { CollaborationStore } from "@sugabots/core/conversations/tools/collaborate/store";
import type { ConnectionTools } from "@sugabots/core/conversations/tools/connections";
import { facilitatorWorkerLayer } from "@sugabots/core/conversations/turns/facilitator";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import type { TurnStore } from "@sugabots/core/conversations/turns/store";
import { turnWorkerLayer } from "@sugabots/core/conversations/turns/worker";
import { type Database, layer as databaseLayer } from "@sugabots/core/database/database";
import type { EventBus } from "@sugabots/core/database/events/bus";
import { eventPruningLayer } from "@sugabots/core/database/events/prune";
import type { PublishEvents } from "@sugabots/core/database/events/publish";
import type { EventStore } from "@sugabots/core/database/events/store";
import { Layer, ManagedRuntime } from "effect";
import type { Pool } from "pg";

/**
 * Everything in the process that has a lifetime: the database pool, and the
 * background loops that run for as long as the process does.
 *
 * Each is a layer, so disposing the runtime stops them in the reverse of the
 * order they started, and nothing needs a `stop()` that somebody has to call
 * in the right order. The stores are not here: they are plain objects with no
 * state of their own, built in `index.ts` and handed to whoever needs them.
 */
export interface RuntimeOptions {
	/** One pool for the process. The runtime closes it on dispose. */
	pool: Pool;
	/** Where durable events live, for the nightly prune. */
	eventStore: EventStore;
	/** Where the turn worker publishes token deltas and watches for collaborators' answers. */
	bus: Pick<EventBus, "publish" | "subscribe">;
	model: TurnModel;
	turns: TurnStore;
	summaries: SummaryStore;
	routines?: RoutineStore;
	collaborations: CollaborationStore;
	/** Where built-in tool calls are written down. */
	calls: ToolCallStore;
	approvals?: ToolApprovalStore;
	/** The built-in tools a workspace's crew turns are offered. */
	builtInTools: BuiltInTools;
	/** The tools inherited from an agent's pod for a turn. */
	connectionTools: ConnectionTools;
	/** For the facilitator to announce who it invited. */
	publishEvents: PublishEvents;
}

export function makeRuntime({
	pool,
	eventStore,
	bus,
	model,
	turns,
	summaries,
	routines,
	collaborations,
	calls,
	approvals = noToolApprovalStore,
	builtInTools,
	connectionTools,
	publishEvents,
}: RuntimeOptions) {
	const database = databaseLayer(pool);
	const background = Layer.mergeAll(
		eventPruningLayer(eventStore),
		...(routines
			? [routineDispatcherLayer({ store: routines }), routineSchedulerLayer({ store: routines })]
			: []),
		turnWorkerLayer({
			store: turns,
			model,
			events: bus,
			collaborations,
			calls,
			approvals,
			builtInTools,
			connectionTools,
			routines,
		}),
		summaryWorkerLayer({ store: summaries, model }),
		facilitatorWorkerLayer({ model, publishEvents, routines }),
	).pipe(Layer.provide(database));

	return ManagedRuntime.make(Layer.merge(database, background));
}

export type AppRuntime = ManagedRuntime.ManagedRuntime<Database, never>;

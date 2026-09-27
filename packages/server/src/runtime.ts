import { routineDispatcherLayer } from "@sugabots/core/conversations/routines/dispatcher";
import { routineSchedulerLayer } from "@sugabots/core/conversations/routines/scheduler";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import type { SummaryRequest } from "@sugabots/core/conversations/summaries/summary.workflow";
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
import type { Database } from "@sugabots/core/database/database";
import type { EventBus } from "@sugabots/core/database/events/bus";
import { eventPruningLayer } from "@sugabots/core/database/events/prune";
import type { PublishEvents } from "@sugabots/core/database/events/publish";
import type { EventStore } from "@sugabots/core/database/events/store";
import { type Effect, Layer } from "effect";

/**
 * The background loops that run for as long as the process does.
 *
 * The stores are not here: they are plain objects with no state of their own,
 * built in `index.ts` and handed to whoever needs them.
 */
export interface BackgroundOptions {
	/** Where durable events live, for the nightly prune. */
	eventStore: EventStore;
	/** Where the turn worker publishes token deltas and watches for collaborators' answers. */
	bus: Pick<EventBus, "publish" | "subscribe">;
	model: TurnModel;
	turns: TurnStore;
	/** Asks the Scribe to catch up on a thread after a completed reply. */
	queueSummary: (request: SummaryRequest) => Effect.Effect<void>;
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

export function backgroundLayer({
	eventStore,
	bus,
	model,
	turns,
	queueSummary,
	routines,
	collaborations,
	calls,
	approvals = noToolApprovalStore,
	builtInTools,
	connectionTools,
	publishEvents,
}: BackgroundOptions): Layer.Layer<never, never, Database> {
	return Layer.mergeAll(
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
			queueSummary,
		}),
		facilitatorWorkerLayer({ model, publishEvents, routines }),
	);
}

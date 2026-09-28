import { DomainEvents } from "../database/events/domain-events.ts";
import type { PublishEvents } from "../database/events/publish.ts";
import { chatStore } from "./chats/store.ts";
import type { ConversationEvent } from "./events.ts";
import type { RoutineRuns } from "./routines/runs.ts";
import { routineStore } from "./routines/store.ts";
import { summaryStore } from "./summaries/store.ts";
import { ThreadFeed } from "./thread-feed.ts";
import { threadStore } from "./threads/store.ts";
import { toolApprovalStore } from "./tools/approvals/store.ts";
import { toolCallStore } from "./tools/calls/store.ts";
import { collaborationStore } from "./tools/collaborate/store.ts";
import type { QueueFacilitation, QueueTurn } from "./turns/queue.ts";
import type { TurnSignals } from "./turns/signals.ts";
import { turnStore } from "./turns/store.ts";

export interface ConversationDependencies {
	/** Where the stream events that show clients what happened are recorded. */
	readonly publishEvents: PublishEvents;
	readonly queueTurn: QueueTurn;
	readonly queueFacilitation: QueueFacilitation;
	readonly signals: TurnSignals;
	readonly routineRuns: RoutineRuns;
}

/** The conversation stores, and the handlers of the domain events they emit, in order. */
export function composeConversations(dependencies: ConversationDependencies) {
	const { publishEvents, queueTurn, queueFacilitation, signals, routineRuns } = dependencies;
	const emit = DomainEvents.emitTo<ConversationEvent>([ThreadFeed.handler(publishEvents)]);
	return {
		/** For recording conversation facts outside the stores, as the facilitator does. */
		emit,
		stores: {
			chats: chatStore(emit, queueTurn, queueFacilitation),
			routines: routineStore(emit, queueTurn, signals, routineRuns),
			threads: threadStore(),
			turns: turnStore(emit, queueTurn, queueFacilitation, signals),
			summaries: summaryStore(emit),
			collaborations: collaborationStore(emit, queueTurn),
			calls: toolCallStore(emit),
			approvals: toolApprovalStore(emit, signals),
		},
	};
}

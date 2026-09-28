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
import { toolCallRepository } from "./tools/calls/repository.ts";
import { collaborationStore } from "./tools/collaborate/store.ts";
import { turnExecution } from "./turns/execution.ts";
import type { QueueFacilitation, QueueTurn } from "./turns/queue.ts";
import { turnRepository } from "./turns/repository.ts";
import type { TurnSignals } from "./turns/signals.ts";

export interface ConversationDependencies {
	/** Where the stream events that show clients what happened are recorded. */
	readonly publishEvents: PublishEvents;
	readonly queueTurn: QueueTurn;
	readonly queueFacilitation: QueueFacilitation;
	readonly signals: TurnSignals;
	readonly routineRuns: RoutineRuns;
}

/**
 * The conversation repositories and stores, and the handlers of the domain
 * events they emit, in order.
 */
export function composeConversations(dependencies: ConversationDependencies) {
	const { publishEvents, queueTurn, queueFacilitation, signals, routineRuns } = dependencies;
	const emit = DomainEvents.emitTo<ConversationEvent>([ThreadFeed.handler(publishEvents)]);
	const toolCalls = toolCallRepository(emit);
	const turns = turnRepository(emit, toolCalls);
	return {
		/** For recording conversation facts outside the stores, as the facilitator does. */
		emit,
		repositories: { turns, toolCalls },
		stores: {
			chats: chatStore(emit, queueTurn, queueFacilitation),
			routines: routineStore(emit, turns, queueTurn, signals, routineRuns),
			threads: threadStore(),
			turns: turnExecution({ turns, emit, queueTurn, queueFacilitation, signals }),
			summaries: summaryStore(emit, turns),
			collaborations: collaborationStore(emit, queueTurn),
			approvals: toolApprovalStore(toolCalls, turns, signals),
		},
	};
}

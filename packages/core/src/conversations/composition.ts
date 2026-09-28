import { Effect } from "effect";
import { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { chatStore } from "./chats/store.ts";
import type { ConversationEvent } from "./events.ts";
import { RoutineSettlement } from "./routines/settlement.ts";
import { routineStore } from "./routines/store.ts";
import { summaryStore } from "./summaries/store.ts";
import { ThreadFeed } from "./thread-feed.ts";
import { threadStore } from "./threads/store.ts";
import { toolApprovalStore } from "./tools/approvals/store.ts";
import { toolCallRepository } from "./tools/calls/repository.ts";
import { collaborationStore } from "./tools/collaborate/store.ts";
import { turnExecution } from "./turns/execution.ts";
import { turnRepository } from "./turns/repository.ts";

/**
 * The conversation repositories and stores, and the handlers of the domain
 * events they emit, in order: the thread feed tells watching clients what
 * happened, then routine settlement ends the runs that work finished.
 */
export const composeConversations = Effect.gen(function* () {
	const outbox = yield* EventOutbox.Service;
	// Settlement acts through the repositories and stores, which emit, so
	// `emit` hands their events to handlers built after them.
	const emit: DomainEvents.Emit<ConversationEvent> = (events) => dispatch(events);
	const toolCalls = toolCallRepository(emit);
	const turns = turnRepository(emit, toolCalls);
	const collaborations = yield* collaborationStore(emit);
	const settlement = yield* RoutineSettlement.make(emit, turns, collaborations);
	const dispatch = DomainEvents.emitTo<ConversationEvent>([
		ThreadFeed.handler(outbox),
		settlement.handler,
	]);
	return {
		/** For recording conversation facts outside the stores, as the facilitator does. */
		emit,
		repositories: { turns, toolCalls },
		/** For the routine workflow's steps. */
		settlement,
		stores: {
			chats: yield* chatStore(emit),
			routines: yield* routineStore(emit),
			threads: threadStore(),
			turns: yield* turnExecution(turns, emit),
			summaries: summaryStore(emit, turns),
			collaborations,
			approvals: yield* toolApprovalStore(toolCalls, turns),
		},
	};
});

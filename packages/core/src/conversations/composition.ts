import { Effect } from "effect";
import { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { chatStore } from "./chats/store.ts";
import type { ConversationEvent } from "./events.ts";
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
 * events they emit, in order.
 */
export const composeConversations = Effect.gen(function* () {
	const outbox = yield* EventOutbox.Service;
	const emit = DomainEvents.emitTo<ConversationEvent>([ThreadFeed.handler(outbox)]);
	const toolCalls = toolCallRepository(emit);
	const turns = turnRepository(emit, toolCalls);
	return {
		/** For recording conversation facts outside the stores, as the facilitator does. */
		emit,
		repositories: { turns, toolCalls },
		stores: {
			chats: yield* chatStore(emit),
			routines: yield* routineStore(emit, turns),
			threads: threadStore(),
			turns: yield* turnExecution(turns, emit),
			summaries: summaryStore(emit, turns),
			collaborations: yield* collaborationStore(emit),
			approvals: yield* toolApprovalStore(toolCalls, turns),
		},
	};
});

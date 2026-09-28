export * as Conversations from "./conversations.ts";

import { Context, Effect, Layer } from "effect";
import { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { ChatView } from "./chats/chat-view.ts";
import { Chats } from "./chats/chats.ts";
import { Compactions } from "./compaction/compactions.ts";
import { ConversationEvents } from "./conversation-events.ts";
import type { ConversationEvent } from "./events.ts";
import { RoutineRunner } from "./routines/routine-runner.ts";
import { RoutineView } from "./routines/routine-view.ts";
import { RoutineWebhooks } from "./routines/routine-webhooks.ts";
import { Routines } from "./routines/routines.ts";
import { RoutineSettlement } from "./routines/settlement.ts";
import { Summaries } from "./summaries/summaries.ts";
import { ThreadFeed } from "./thread-feed.ts";
import { ThreadRepository } from "./threads/repository.ts";
import { ThreadView } from "./threads/thread-view.ts";
import { ApprovedToolCalls } from "./tools/approvals/approved-calls.ts";
import { ToolApprovals } from "./tools/approvals/tool-approvals.ts";
import { ToolCallRepository } from "./tools/calls/repository.ts";
import { Collaborations } from "./tools/collaborate/collaborations.ts";
import { TurnCancellation } from "./turns/cancellation.ts";
import { TurnExecution } from "./turns/execution.ts";
import { FloorControl } from "./turns/floor-control.ts";
import { TurnRepository } from "./turns/repository.ts";

const services = Layer.mergeAll(
	Chats.layer,
	Collaborations.layer,
	ToolApprovals.layer,
	ApprovedToolCalls.layer,
	TurnExecution.layer,
	TurnCancellation.layer,
	Routines.layer,
	RoutineWebhooks.layer,
	RoutineRunner.layer,
	Summaries.layer,
	Compactions.layer,
	RoutineSettlement.layer,
	ChatView.layer,
	ThreadView.layer,
	RoutineView.layer,
	FloorControl.layer,
	// The repositories workflow steps write through: a turn's steps record its
	// reply and tool calls, a summary's failure is recorded on the Scribe's
	// turn, as is a compaction's, and the Facilitator brings the agent it picks
	// into the thread.
	TurnRepository.layer,
	ToolCallRepository.layer,
	ThreadRepository.layer,
);

/** Everything `layer` provides. */
export type Services = Layer.Success<typeof services> | ConversationEvents.Service;

/**
 * The conversation services, with `ConversationEvents` handing what they
 * emit to its handlers, in order: the thread feed tells watching clients what
 * happened, then routine settlement ends the runs that work finished.
 */
export const layer = Layer.effectContext(
	Effect.gen(function* () {
		const outbox = yield* EventOutbox.Service;
		// Settlement is built from the services that emit, so `emit` reaches the
		// handlers through `dispatch`, which exists once they are built. Nothing
		// emits while they are being built.
		const events = ConversationEvents.Service.of({ emit: (batch) => dispatch(batch) });
		const built = yield* Layer.build(
			services.pipe(Layer.provide(Layer.succeed(ConversationEvents.Service, events))),
		);
		const dispatch = DomainEvents.emitTo<ConversationEvent>([
			ThreadFeed.handler(outbox),
			Context.get(built, RoutineSettlement.Service).handler,
		]);
		return Context.add(built, ConversationEvents.Service, events);
	}),
);

export * as Conversations from "./conversations.ts";

import { Context, Effect, Layer } from "effect";
import { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { Notifications } from "../notifications/notifications.ts";
import { ChatView } from "./chats/chat-view.ts";
import { Chats } from "./chats/chats.ts";
import { Compactions } from "./compaction/compactions.ts";
import { ConversationEvents } from "./conversation-events.ts";
import type { ConversationEvent } from "./events.ts";
import { FloorControl } from "./floor/floor-control.ts";
import { RoutineRunner } from "./routines/routine-runner.ts";
import { RoutineView } from "./routines/routine-view.ts";
import { RoutineWebhooks } from "./routines/routine-webhooks.ts";
import { Routines } from "./routines/routines.ts";
import { RoutineSettlement } from "./routines/settlement.ts";
import { Summaries } from "./summaries/summaries.ts";
import { ThreadFeed } from "./thread-feed.ts";
import { ThreadRepository } from "./threads/repository.ts";
import { ThreadView } from "./threads/thread-view.ts";
import { Collaborations } from "./tools/collaborate/collaborations.ts";
import { Turns } from "./turns/turns.ts";

/**
 * `Turns` is provided here, once, to all of these. The turn's own steps call
 * back into collaborations and floor control, so a service providing it
 * itself would load it before it exists.
 */
const services = Layer.mergeAll(
	Chats.layer,
	Collaborations.layer,
	Routines.layer,
	RoutineWebhooks.layer,
	RoutineRunner.layer,
	Summaries.layer,
	Compactions.layer,
	RoutineSettlement.layer,
	Notifications.layer,
	ChatView.layer,
	ThreadView.layer,
	RoutineView.layer,
	FloorControl.layer,
	// The Facilitator's workflow step brings the agent it picks into the thread.
	ThreadRepository.layer,
).pipe(Layer.provideMerge(Turns.layer));

/** Everything `layer` provides. */
export type Services = Layer.Success<typeof services> | ConversationEvents.Service;

/**
 * The conversation services, with `ConversationEvents` handing what they
 * emit to its handlers, in order: the thread feed tells watching clients what
 * happened, notifications tell the people it needs, routine settlement ends
 * the runs that work finished, collaborations whose collaborator stopped
 * without answering fail, the floor passes after each completed reply, and
 * the reply asks for its thread's summary and, past the compaction line, its
 * compaction once it commits.
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
			Context.get(built, Notifications.Service).handler,
			Context.get(built, RoutineSettlement.Service).handler,
			Context.get(built, Collaborations.Service).handler,
			Context.get(built, FloorControl.Service).handler,
			Context.get(built, Summaries.Service).handler,
			Context.get(built, Compactions.Service).handler,
		]);
		return Context.add(built, ConversationEvents.Service, events);
	}),
);

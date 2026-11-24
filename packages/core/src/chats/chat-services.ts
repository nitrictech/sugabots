export * as ChatServices from "./chat-services.ts";

import { Context, Effect, Layer } from "effect";
import { DomainEvents } from "../database/events/domain-events.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { Notifications } from "../notifications/notifications.ts";
import { BotAdministration } from "../workspaces/bots/bot-administration.ts";
import { WorkspaceTimeZone } from "../workspaces/time-zone/workspace-time-zone.ts";
import { AssistantGuide } from "./assistant/assistant-guide.ts";
import { AutomationRunner } from "./automations/automation-runner.ts";
import { Automations } from "./automations/automations.ts";
import { BotAutomations } from "./automations/bot-automations.ts";
import { AutomationSettlement } from "./automations/settlement.ts";
import { AutomationWorkAdmission } from "./automations/work-admission.ts";
import { ChatDetailsView } from "./chat-details-view.ts";
import { ChatEventStream } from "./chat-event-stream.ts";
import { ChatEvents } from "./chat-events.ts";
import { BotChats } from "./chats/bot-chats.ts";
import { ChatFiles } from "./chats/chat-files.ts";
import { ChatView } from "./chats/chat-view.ts";
import { Chats } from "./chats/chats.ts";
import { Compactions } from "./compaction/compactions.ts";
import type { ChatEvent } from "./events.ts";
import { FloorControl } from "./floor/floor-control.ts";
import { Reactions } from "./reactions/reactions.ts";
import { Turns } from "./turns/turns.ts";

/**
 * `Turns` is provided here, once, to all of these, with automation runs deciding
 * which chats take more work (see `WorkAdmission`). Floor control asks for
 * turns and reads what they wrote, so a service providing it itself would load
 * it before it exists.
 */
const services = Layer.mergeAll(
	Chats.layer,
	Reactions.layer,
	ChatFiles.layer,
	Automations.layer,
	Automations.webhooksLayer,
	Automations.connectorEventsLayer,
	// The turn's steps read it from here, for the automation tools.
	BotAutomations.layer,
	// The turn's steps read it from here, for start_chat.
	BotChats.layer,
	// The turn's steps read it from here, for a Personal Assistant's tools.
	AssistantGuide.layer,
	// The turn's steps read it from here, for save_instructions.
	BotAdministration.layer,
	// Moving the workspace's zone moves its automations' routines, through the store that emits.
	WorkspaceTimeZone.layer,
	AutomationRunner.layer,
	Compactions.layer,
	AutomationSettlement.layer,
	ChatView.layer,
	ChatDetailsView.layer,
	FloorControl.layer,
).pipe(Layer.provideMerge(Turns.layer), Layer.provideMerge(AutomationWorkAdmission.layer));

/** Everything `layer` provides. */
export type Services = Layer.Success<typeof services> | ChatEvents.Service;

/**
 * The chat services, with `ChatEvents` handing what they
 * emit to its handlers, in order: the chat event stream tells watching clients what
 * happened, automation settlement ends the runs that work finished, the floor
 * passes to the bots a completed reply asks for help and back to the asking
 * bot once they are done, a reply past the compaction line asks for
 * its chat's compaction once it commits, and
 * members are notified of finished messages and approvals waiting on them.
 */
export const layer = Layer.effectContext(
	Effect.gen(function* () {
		const outbox = yield* EventOutbox.Service;
		const notifications = yield* Notifications.Service;
		// Settlement is built from the services that emit, so `emit` reaches the
		// handlers through `dispatch`, which exists once they are built. Nothing
		// emits while they are being built.
		const events = ChatEvents.Service.of({ emit: (batch) => dispatch(batch) });
		const built = yield* Layer.build(
			services.pipe(Layer.provide(Layer.succeed(ChatEvents.Service, events))),
		);
		const dispatch = DomainEvents.emitTo<ChatEvent>([
			ChatEventStream.handler(outbox),
			Context.get(built, AutomationSettlement.Service).handler,
			Context.get(built, FloorControl.Service).handler,
			Context.get(built, Compactions.Service).handler,
			notifications.handler,
		]);
		// Internals included: the workflows' steps and the automation scheduler read
		// them from here. Routes cannot, as `HttpServices` admits only public tags.
		return Context.add(built, ChatEvents.Service, events);
	}),
);

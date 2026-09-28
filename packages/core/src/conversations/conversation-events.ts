export * as ConversationEvents from "./conversation-events.ts";

import { Context } from "effect";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { ConversationEvent } from "./events.ts";

/**
 * Where the conversation services record what happened, for the handlers
 * `Conversations.layer` gives it, in order, inside the emitting transaction
 * (see `DomainEvents.emitTo`).
 *
 * There is no `layer` here: the handlers include routine settlement, which is
 * built from the services that emit, so `Conversations.layer` builds both and
 * provides this.
 */
export interface Interface {
	readonly emit: DomainEvents.Emit<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConversationEvents",
) {}

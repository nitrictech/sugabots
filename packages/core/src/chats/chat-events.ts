export * as ChatEvents from "./chat-events.ts";

import { Context } from "effect";
import type { DomainEvents } from "../database/events/domain-events.ts";
import type { ChatEvent } from "./events.ts";

/**
 * Where the chat services record what happened, for the handlers
 * `ChatServices.layer` gives it, in order, inside the emitting transaction
 * (see `DomainEvents.emitTo`).
 *
 * There is no `layer` here: the handlers include automation settlement, which is
 * built from the services that emit, so `ChatServices.layer` builds both and
 * provides this.
 */
export interface Interface {
	readonly emit: DomainEvents.Emit<ChatEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatEvents") {}

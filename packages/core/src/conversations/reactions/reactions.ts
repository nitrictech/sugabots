export * as Reactions from "./reactions.ts";

import type { MessageReaction } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ResourceHidden } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { message } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { ThreadRepository } from "../threads/repository.ts";

/**
 * People reacting to messages with emoji. Whoever sees a message's thread may
 * react to it, and take their own reactions back. Bots never react.
 */
export interface Interface {
	/**
	 * Adds the actor's `emoji` to the message, answering with all its reactions.
	 * Adding one already there changes nothing.
	 */
	readonly add: (
		messageId: string,
		emoji: string,
	) => Effect.Effect<
		MessageReaction[],
		ResourceHidden | ThreadRepository.MessageNotFinished | ThreadRepository.TooManyReactionEmoji,
		CurrentActor.Service
	>;
	/** Takes the actor's `emoji` off the message, if it is there, answering with what is left. */
	readonly remove: (
		messageId: string,
		emoji: string,
	) => Effect.Effect<MessageReaction[], ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Reactions") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Reactions");
	const visibility = yield* Visibility.Service;
	const threads = yield* ThreadRepository.Service;

	/** The actor's reaction with `emoji` to the message, once they are known to see it. */
	const actorReaction = (messageId: string, emoji: string) =>
		Effect.gen(function* () {
			if (!isUuid(messageId)) return yield* new ResourceHidden({ resource: "message" });
			const [found] = yield* query((db) =>
				db
					.select({ threadId: message.threadId })
					.from(message)
					.where(eq(message.id, messageId))
					.limit(1),
			);
			if (!found) return yield* new ResourceHidden({ resource: "message" });
			yield* visibility.thread(found.threadId);
			const { userId } = yield* CurrentActor.Service;
			return { threadId: found.threadId, messageId, userId, emoji };
		});

	return Service.of({
		add: (messageId, emoji) =>
			operation(
				"add",
				transaction(Effect.flatMap(actorReaction(messageId, emoji), threads.addReaction)),
			),
		remove: (messageId, emoji) =>
			operation(
				"remove",
				transaction(Effect.flatMap(actorReaction(messageId, emoji), threads.removeReaction)),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Visibility.layer, ThreadRepository.layer]));

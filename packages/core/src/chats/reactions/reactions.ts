export * as Reactions from "./reactions.ts";

import type { MessageReaction } from "@sugabots/contracts";
import type { MessageNotFinished, TooManyReactionEmoji } from "@sugabots/contracts/errors/chats";
import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { ReachesMessage } from "../../proofs/reaches-message.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatStore } from "../store/store.ts";

/**
 * Members reacting to messages with emoji. Whoever reaches a message's chat
 * may react to it, and take their own reactions back. A bot reacts only with
 * 👀, when it reads a message and stays silent (see `TurnStore.staySilent`).
 */
export interface Interface {
	/**
	 * Adds the member's `emoji` to the message `reach` is about, answering
	 * with all its reactions. Adding one already there changes nothing.
	 */
	readonly add: <P, M>(
		isMember: IsMember<P>,
		reach: ReachesMessage<P, M>,
		emoji: string,
	) => Effect.Effect<MessageReaction[], MessageNotFinished | TooManyReactionEmoji>;
	/** Takes the member's `emoji` off the message, if it is there, answering with what is left. */
	readonly remove: <P, M>(
		isMember: IsMember<P>,
		reach: ReachesMessage<P, M>,
		emoji: string,
	) => Effect.Effect<MessageReaction[]>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Reactions") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Reactions");
	const chats = yield* ChatStore.Service;

	/** The member's reaction with `emoji` to the message `reach` is about, in its chat. */
	const reactionOf = <P, M>(isMember: IsMember<P>, reach: ReachesMessage<P, M>, emoji: string) => ({
		chatId: reach.chat,
		messageId: reach.message.value,
		memberId: isMember.member,
		emoji,
	});

	return Service.of({
		add: (isMember, reach, emoji) =>
			operation("add", transaction(chats.addReaction(reactionOf(isMember, reach, emoji)))),
		remove: (isMember, reach, emoji) =>
			operation("remove", transaction(chats.removeReaction(reactionOf(isMember, reach, emoji)))),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ChatStore.layer));

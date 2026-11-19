export * as FloorControl from "./floor-control.ts";

import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import type { UserFacing } from "../../user-message.ts";
import type { ConversationEvent } from "../events.ts";
import { ConversationRepository } from "../repository/repository.ts";
import { Turns } from "../turns/turns.ts";
import { decideFloor, type FloorMessage, loadFloorScope } from "./floor.ts";

/** Who speaks after a person's message, in a conversation of any type. */
export interface Interface {
	/**
	 * Decides who speaks after the committed message `committed` (see
	 * `decideFloor`) and asks for them: brings each addressed bot into the
	 * conversation and asks for its turn. Runs in the caller's transaction, so it
	 * commits with the message. Refused, before any turn is asked for, when a
	 * bot given the floor has no model, so the caller's transaction rolls the
	 * message back rather than keep it with a turn that could only fail.
	 */
	readonly giveFloor: (committed: FloorMessage) => Effect.Effect<void, BotHasNoModel>;
	/**
	 * Asks for the collaborator's turn when a collaboration opens, for the
	 * asking bot's when a collaboration ends after it stopped waiting, and
	 * for the bot's in a conversation another bot started and briefed it in.
	 */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FloorControl") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FloorControl");
	const conversations = yield* ConversationRepository.Service;
	const turns = yield* Turns.Service;

	const giveFloor: Interface["giveFloor"] = (committed) =>
		operation(
			"giveFloor",
			transaction(
				Effect.gen(function* () {
					const scope = yield* query((db) => loadFloorScope(db, committed));
					const decision = decideFloor({ ...scope, content: committed.content });
					if (decision.kind !== "turns") return;
					const modelled = new Set(
						scope.mentionableBots.flatMap((member) => (member.hasModel ? [member.id] : [])),
					);
					if (scope.lead?.hasModel) modelled.add(scope.lead.id);
					if (decision.bots.some(({ botId }) => !modelled.has(botId))) {
						return yield* new BotHasNoModel();
					}
					yield* conversations.addBots(
						committed.conversationId,
						decision.bots.map(({ botId }) => botId),
					);
					for (const { botId, reason } of decision.bots) {
						yield* turns.ask({
							conversationId: committed.conversationId,
							botId,
							triggerMessageId: committed.id,
							reason,
						});
					}
				}),
			),
		);

	return Service.of({
		giveFloor,
		handler: (events) =>
			Effect.forEach(
				events,
				(event): Effect.Effect<unknown> => {
					switch (event._tag) {
						case "CollaborationOpened":
							return turns.ask({
								conversationId: event.collaboration.conversationId,
								botId: event.collaboratorBotId,
								triggerMessageId: event.briefMessageId,
								reason: "collaboration",
							});
						// The brief is a bot's message, which gives nobody the floor by itself.
						case "BriefedThreadStarted":
							return turns.ask({
								conversationId: event.conversationId,
								botId: event.hostBotId,
								triggerMessageId: event.briefMessageId,
								reason: "brief",
							});
						case "CollaborationAnswered":
						case "CollaborationFailed":
							return event.askerToResume
								? turns.ask({
										conversationId: event.parentConversationId,
										botId: event.askerToResume,
										triggerMessageId: event.parentMessageId,
										reason: "resume",
									})
								: Effect.void;
						default:
							return Effect.void;
					}
				},
				{ discard: true },
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ConversationRepository.layer));

/**
 * A bot given the floor has no model, so nothing could answer. The message is
 * not kept, rather than kept with a turn that will never run.
 */
export class BotHasNoModel extends Data.TaggedError("BotHasNoModel") implements UserFacing {
	get userMessage() {
		return userText`This bot has no model chosen, so it can't answer yet`;
	}
}

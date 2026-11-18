export * as FloorControl from "./floor-control.ts";

import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
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
	 * commits with the message.
	 */
	readonly giveFloor: (committed: FloorMessage) => Effect.Effect<void>;
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
						case "BriefedTaskStarted":
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

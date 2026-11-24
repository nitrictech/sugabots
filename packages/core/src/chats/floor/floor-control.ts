export { BotHasNoModel } from "@sugabots/contracts/errors/chats";
export * as FloorControl from "./floor-control.ts";

import { helpersAskedBy, mentionedHandles } from "@sugabots/contracts";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { type Database, query, serviceOperations, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { message } from "../../database/schema.ts";
import type { ChatEvent } from "../events.ts";
import { ChatStore } from "../store/store.ts";
import { Turns } from "../turns/turns.ts";
import { type FloorMessage, floorOf, loadFloorScope, loadRepliedTurn } from "./floor.ts";

/** Who speaks after a message, in a chat of any type. */
export interface Interface {
	/**
	 * Decides who speaks after the committed message `committed` (see
	 * `floorOf`) and asks for them: brings each addressed bot into the
	 * chat and asks for its turn. Runs in the caller's transaction, so it
	 * commits with the message. Refused, before any turn is asked for, when a
	 * bot given the floor has no model, so the caller's transaction rolls the
	 * message back rather than keep it with a turn that could only fail.
	 */
	readonly giveFloor: (committed: FloorMessage) => Effect.Effect<void, BotHasNoModel>;
	/**
	 * Asks for the turns bots' messages give (GLOSSARY.md's "Collaboration"):
	 * a helper's for each bot a completed reply asks for help (see
	 * `helpersAskedBy`), on that reply; the asking bot's hand-back on it once
	 * every one of its helpers' turns has ended; and the bot's, in a chat
	 * another bot started and briefed it in.
	 */
	readonly handler: DomainEvents.Handler<ChatEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FloorControl") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FloorControl");
	const chats = yield* ChatStore.Service;
	const turns = yield* Turns.Service;

	const giveFloor: Interface["giveFloor"] = (committed) =>
		operation(
			"giveFloor",
			transaction(
				Effect.gen(function* () {
					const scope = yield* query((db) => loadFloorScope(db, committed));
					const decision = floorOf({ ...scope, content: committed.content });
					if (decision.kind !== "turns") return;
					const modelled = new Set(
						scope.mentionableBots.flatMap((bot) => (bot.hasModel ? [bot.id] : [])),
					);
					if (decision.bots.some(({ botId }) => !modelled.has(botId))) {
						return yield* new BotHasNoModel();
					}
					yield* chats.addBots(
						committed.chatId,
						decision.bots.map(({ botId }) => botId),
					);
					for (const { botId, reason } of decision.bots) {
						yield* turns.ask({
							chatId: committed.chatId,
							botId,
							triggerMessageId: committed.id,
							reason,
						});
					}
				}),
			),
		);

	/**
	 * Asks for the hand-back of the bot that wrote `askingMessageId`, once it
	 * is owed (see `Turns.handBackOwed`), in the caller's transaction, which
	 * ended a helper's turn. The asking message is locked first, so of two
	 * helpers' turns ending at once, the second sees the first's end.
	 * `endedHelperBotId` is the helper whose turn the caller's transaction
	 * ended or gave up on. Only a reply a turn wrote asks for help, so a
	 * message no turn wrote, such as a brief, is owed nothing.
	 */
	const handBackIfOwed = (askingMessageId: string, endedHelperBotId?: string) =>
		Effect.gen(function* () {
			const [asking] = yield* query((db) =>
				db
					.select({
						chatId: message.chatId,
						botId: message.authorBotId,
						turnId: message.turnId,
					})
					.from(message)
					.where(eq(message.id, askingMessageId))
					.for("no key update"),
			);
			const askingBotId = asking?.botId;
			if (!askingBotId || asking.turnId === null) return;
			const owed = yield* query((db) =>
				Turns.handBackOwed(
					db,
					{ chatId: asking.chatId, messageId: askingMessageId, botId: askingBotId },
					endedHelperBotId,
				),
			);
			if (!owed) return;
			yield* turns.ask({
				chatId: asking.chatId,
				botId: askingBotId,
				triggerMessageId: askingMessageId,
				reason: "hand_back",
			});
		});

	/**
	 * After the bot `botId`'s reply `messageId` completed: a helper's may owe
	 * the bot that asked it its hand-back, and any other may ask for help.
	 */
	const afterReply = (reply: {
		chatId: string;
		turnId: string;
		botId: string;
		messageId: string;
		content: string;
	}) =>
		Effect.gen(function* () {
			const replied = yield* query((db) => loadRepliedTurn(db, reply.turnId));
			if (!replied) return;
			if (replied.reason === "collaboration") {
				yield* handBackIfOwed(replied.triggerMessageId, reply.botId);
			}
			const mentioned = mentionedHandles(reply.content);
			// In one order, so two replies asking the same helpers lock their rows and lanes alike.
			const helpers = helpersAskedBy({
				chatKind: replied.chatKind,
				authorBotId: reply.botId,
				mayAsk: replied.reason !== "collaboration",
				mentionedBotIds: replied.modelledBots.flatMap((bot) =>
					mentioned.includes(bot.handle) ? [bot.id] : [],
				),
				alreadyAsked: yield* query((db) => Turns.botsAskedBefore(db, reply.messageId)),
			}).toSorted();
			if (helpers.length === 0) return;
			yield* chats.addBots(reply.chatId, helpers);
			for (const botId of helpers) {
				yield* turns.ask({
					chatId: reply.chatId,
					botId,
					triggerMessageId: reply.messageId,
					reason: "collaboration",
				});
			}
		});

	/** After the bot `botId`'s turn `turnId` ended without completing: a helper's may owe a hand-back. */
	const afterTurnEnded = (ended: { turnId: string; botId: string }) =>
		Effect.gen(function* () {
			const replied = yield* query((db) => loadRepliedTurn(db, ended.turnId));
			if (replied?.reason !== "collaboration") return;
			yield* handBackIfOwed(replied.triggerMessageId, ended.botId);
		});

	return Service.of({
		giveFloor,
		handler: (events) =>
			operation(
				"handler",
				Effect.forEach(
					events,
					(event): Effect.Effect<unknown, never, Database> => {
						switch (event._tag) {
							case "TurnCompleted":
								return afterReply(event);
							case "TurnFailed":
								// A turn that runs again has not ended.
								return event.willRetry ? Effect.void : afterTurnEnded(event);
							case "TurnInterrupted":
								return afterTurnEnded(event);
							// A helper's turn given up on before it opened, or found ended.
							case "TurnAbandoned":
								return event.reason === "collaboration"
									? handBackIfOwed(event.triggerMessageId, event.botId)
									: Effect.void;
							// In case a helper's request left its lane without any turn event.
							case "LaneReleased":
								return event.reason === "collaboration"
									? handBackIfOwed(event.triggerMessageId)
									: Effect.void;
							// The brief is a bot's message, which gives nobody the floor by itself.
							case "BriefedChatStarted":
								return turns.ask({
									chatId: event.chatId,
									botId: event.briefedBotId,
									triggerMessageId: event.briefMessageId,
									reason: "brief",
								});
							default:
								return Effect.void;
						}
					},
					{ discard: true },
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ChatStore.layer));

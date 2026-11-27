export { BotHasNoModel } from "@sugabots/contracts/errors/chats";
export * as FloorControl from "./floor-control.ts";

import { type FloorTurnReason, helpersAskedBy, mentionedHandles } from "@sugabots/contracts";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { type Database, query, serviceOperations, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { ACTIVE_TURN_STATUSES, message, turn } from "../../database/schema.ts";
import { named } from "../../proofs/proof.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";
import { proveCanSteer } from "../../proofs/turn-control.ts";
import { processLayer, Tier } from "../../tiers.ts";
import type { ChatEvent } from "../events.ts";
import { ChatStore } from "../store/store.ts";
import { recordJoin } from "../turns/joins.ts";
import { Turns } from "../turns/turns.ts";
import { type FloorMessage, floorOf, loadFloorScope, loadRepliedTurn } from "./floor.ts";

/** Who speaks after a message, in a chat of any type. */
export interface Interface {
	/**
	 * Decides who speaks after the committed message `committed` (see
	 * `floorOf`) and asks for them: brings each addressed bot into the chat,
	 * and asks for its turn, unless a turn of the bot's for the message's author,
	 * who `poster` proves reaches the chat, already answers it: it steers that
	 * turn once running, or joins it before it opens. A message that starts a
	 * chat has no `poster`, as no turn runs there yet.
	 * Runs in the caller's transaction, so it commits with the message. Refused,
	 * before any turn is asked for, when a bot given the floor has no model, so
	 * the caller's transaction rolls the message back rather than keep it with
	 * a turn that could only fail.
	 */
	readonly giveFloor: <P, C>(
		committed: FloorMessage,
		poster: ReachesChat<P, C> | undefined,
	) => Effect.Effect<void, BotHasNoModel>;
	/**
	 * Asks for the turns bots' messages give (GLOSSARY.md's "Collaboration"):
	 * a helper's for each bot a completed reply asks for help (see
	 * `helpersAskedBy`), on that reply; the asking bot's hand-back on it once
	 * every one of its helpers' turns has ended; and the bot's, in a chat
	 * another bot started and briefed it in.
	 */
	readonly handler: DomainEvents.Handler<ChatEvent>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FloorControl") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FloorControl");
	const chats = yield* ChatStore.Service;
	const turns = yield* Turns.Service;
	const controls = yield* Turns.Controls;

	/**
	 * Whether the member's message `request.triggerMessageId`, which the floor
	 * gives the bot `request.botId`, is answered by a turn of theirs the bot
	 * already has, rather than needing a turn of its own: it joins their turn
	 * not yet opened, which reads it when it starts, or steers their turn
	 * running or waiting for approvals. `poster`, the message's author, proves
	 * they reach the chat; a message with none answers no turn already there.
	 * It holds the opening of the bot's turns first, as opening one does, so the
	 * message does exactly one of the two, or neither.
	 */
	const answeredByTurnOfTheirs = <P, C>(
		request: Turns.TurnRequests.TurnRequest & { reason: FloorTurnReason },
		poster: ReachesChat<P, C> | undefined,
	) =>
		Effect.gen(function* () {
			if (!poster) return false;
			const acting = poster.principal.value;
			if (acting._tag !== "MemberSession") return false;
			const held = yield* Turns.TurnRequests.holdOpening(request);
			if (
				held &&
				!held.opened &&
				Turns.TurnRequests.joinsUnopened({ ...request, askerId: acting.member }, held.running)
			) {
				yield* recordJoin(request.triggerMessageId, {
					botId: held.running.botId,
					triggerMessageId: held.running.triggerMessageId,
				});
				return true;
			}
			// Several may be active once a turn waiting for approval gives up its
			// lane; the newest the member may steer is theirs. Their rows are
			// locked by id, in the lock order (see `TurnStore`'s `lockedTurn`).
			const working = yield* query((db) =>
				db
					.select({ id: turn.id, startedAt: turn.startedAt })
					.from(turn)
					.where(
						and(
							eq(turn.chatId, request.chatId),
							eq(turn.botId, request.botId),
							inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
							isNull(turn.endRequested),
						),
					)
					.orderBy(asc(turn.id))
					.for("update"),
			);
			// Sorted stably from newest id first, so turns started at once keep that order.
			const newestFirst = working
				.toReversed()
				.toSorted((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
			for (const candidate of newestFirst) {
				const steered = yield* named(candidate.id, (turnId) =>
					proveCanSteer(poster, turnId).pipe(
						Effect.flatMap((canSteer) =>
							controls.steer(canSteer, {
								messageId: request.triggerMessageId,
								reason: request.reason,
							}),
						),
						// Anyone but its asker gets a turn of their own.
						Effect.catchTags({
							ActionForbidden: () => Effect.succeed(false),
							ResourceHidden: () => Effect.succeed(false),
						}),
					),
				);
				if (steered) return true;
			}
			return false;
		});

	/**
	 * Gives the floor to the bots `requests` name, each on the message they
	 * answer, in the lock order (see `TurnStore`'s `lockedTurn`): first each
	 * bot's turn opening and turn rows, as a steer takes them, then each bot's
	 * lane, as asking for a turn takes it, each by bot id.
	 */
	const answerOrAsk = <P, C>(
		requests: ReadonlyArray<Turns.TurnRequests.TurnRequest & { reason: FloorTurnReason }>,
		poster: ReachesChat<P, C> | undefined,
	) =>
		Effect.gen(function* () {
			const byBot = requests.toSorted((left, right) => left.botId.localeCompare(right.botId));
			const asks: Turns.TurnRequests.TurnRequest[] = [];
			for (const request of byBot) {
				if (!(yield* answeredByTurnOfTheirs(request, poster))) asks.push(request);
			}
			for (const request of asks) yield* turns.ask(request);
		});

	const giveFloor: Interface["giveFloor"] = (committed, poster) =>
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
					yield* answerOrAsk(
						decision.bots.map(({ botId, reason }) => ({
							chatId: committed.chatId,
							botId,
							triggerMessageId: committed.id,
							reason,
						})),
						poster,
					);
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

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ChatStore.layer));

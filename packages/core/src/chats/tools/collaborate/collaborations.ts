export * as Collaborations from "./collaborations.ts";

import type { CollaborationPart } from "@sugabots/contracts";
import { MAX_CHAT_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import type { DomainEvents } from "../../../database/events/domain-events.ts";
import type * as schema from "../../../database/schema.ts";
import { bot, collaboration, placedChat, turn } from "../../../database/schema.ts";
import type { ChatEvent } from "../../events.ts";
import { toCollaborationPart } from "../../store/collaboration-parts.ts";
import { madeByPeople } from "../../store/participants.ts";
import { ChatStore } from "../../store/store.ts";
import { makeRecords, type WaitOutcome } from "./store.ts";

/**
 * Collaboration: one bot asking another for help.
 *
 * The asking bot's turn calls the `collaborate` tool mid-reply. That opens a
 * chat of the collaborator's own, whose first message is the brief,
 * and records a collaboration pointing from the reply to that chat. The
 * reply keeps a reference to the collaboration among its parts at the point
 * the call was made, so a reader sees the text before, the child chat, and
 * the text after.
 */
export interface Interface {
	/**
	 * Opens the collaborator's chat with the brief as its first message and
	 * records the collaboration; floor control asks for the collaborator's
	 * turn when it is opened. Fails, writing nothing, when policy refuses.
	 */
	readonly open: (input: {
		/** The asking bot's chat, bot, turn, reply message, and how far into the reply it was. */
		from: {
			chatId: string;
			botId: string;
			turnId: string;
			messageId: string;
			atOffset: number;
		};
		/** The collaborator's name, as the model wrote it. */
		to: string;
		brief: string;
	}) => Effect.Effect<Opened, CollaborationRefused>;
	/**
	 * Ends the asking turn's wait: returns the answer if the collaborator has
	 * given one, or says the collaboration failed and no answer is coming.
	 * Otherwise the turn moves on, and the answer resumes it later in a turn
	 * of its own.
	 */
	readonly collectAnswer: (collaborationId: string) => Effect.Effect<WaitOutcome>;
	/**
	 * Hands the collaborator's reply in its chat `chatId` back to the
	 * bot that asked, when it answers an outstanding brief. Floor control
	 * gives a bot that stopped waiting a turn in the parent chat to pick
	 * the answer up. A reply with nothing outstanding is an ordinary message.
	 */
	readonly answer: (input: { chatId: string; answer: string }) => Effect.Effect<void>;
	/**
	 * Fails a collaboration once its collaborator's turn in its chat ends for
	 * good without answering: failed with no retry, cancelled, or given up
	 * on. An asking bot that stopped waiting gets a turn to say so, as it
	 * told the person it would follow up.
	 */
	readonly handler: DomainEvents.Handler<ChatEvent>;
	/**
	 * Fails the collaborations asked for in these chats that are still
	 * waiting or pending, because the automation run they work for ended. One
	 * another transaction holds is skipped: its holder is moving it on.
	 */
	readonly failUnder: (chatIds: readonly string[]) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Collaborations",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Collaborations");
	const chats = yield* ChatStore.Service;
	const store = yield* makeRecords;

	return Service.of({
		open: ({ from, to, brief }) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const [parent] = yield* query((db) =>
							db.select().from(placedChat).where(eq(placedChat.id, from.chatId)).limit(1),
						);
						if (!parent) {
							return yield* new CollaborationRefused({
								reason: "This chat no longer exists",
							});
						}
						const collaborator = yield* collaboratorNamed(parent, to);
						if (!collaborator) {
							return yield* new CollaborationRefused({
								reason: `No bot in this workspace is called "${to}"`,
							});
						}
						if (collaborator.id === from.botId) {
							return yield* new CollaborationRefused({
								reason: "A bot cannot collaborate with itself",
							});
						}
						const askersAbove = yield* askersAboveOf(parent.id);
						if (askersAbove.length >= MAX_DEPTH) {
							return yield* new CollaborationRefused({
								reason: `Collaboration may only nest ${MAX_DEPTH} deep; answer this yourself`,
							});
						}
						if (askersAbove.includes(collaborator.id)) {
							return yield* new CollaborationRefused({
								reason: `${collaborator.name} is already waiting on this chat; answer it yourself`,
							});
						}
						if (yield* hasAskedThisTurn(from.turnId, collaborator.id)) {
							return yield* new CollaborationRefused({
								reason: `You have already asked ${collaborator.name} this turn; use what you were told`,
							});
						}

						const child = yield* chats.openCollaboration({
							parent,
							askingBotId: from.botId,
							collaboratorId: collaborator.id,
							title: firstLine(brief),
							brief,
						});
						const opened = yield* store.open({
							parentChatId: parent.id,
							rootChatId: parent.rootChatId ?? parent.id,
							parentMessageId: from.messageId,
							turnId: from.turnId,
							chatId: child.chatId,
							briefMessageId: child.briefMessageId,
							collaborator,
							brief,
							atOffset: from.atOffset,
						});
						return { collaboration: toCollaborationPart(opened, collaborator.name), collaborator };
					}),
				),
			),

		collectAnswer: (collaborationId) =>
			operation("collectAnswer", store.stopWaiting(collaborationId)),

		answer: ({ chatId, answer }) => operation("answer", transaction(store.answer(chatId, answer))),

		handler: (events) =>
			Effect.forEach(events.flatMap(unansweredBy), (ended) => store.failUnanswered(ended), {
				discard: true,
			}),

		failUnder: store.failUnder,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ChatStore.layer));

/** The collaborator whose turn in a collaboration's chat the event ended without an answer. */
function unansweredBy(
	event: ChatEvent,
): Array<{ readonly childChatId: string; readonly collaboratorBotId: string }> {
	switch (event._tag) {
		case "TurnFailed":
			// A turn that runs again may still answer.
			return event.willRetry ? [] : [{ childChatId: event.chatId, collaboratorBotId: event.botId }];
		case "TurnCancelled":
		case "TurnAbandoned":
			return [{ childChatId: event.chatId, collaboratorBotId: event.botId }];
		default:
			return [];
	}
}

/** How deep collaboration may nest: a root chat, a child, and a grandchild. */
const MAX_DEPTH = 2;

export type { WaitOutcome };

export interface Opened {
	collaboration: CollaborationPart;
	collaborator: { id: string; name: string };
}

/** Policy said no. The reason goes back to the model as the tool's result. */
export class CollaborationRefused extends Data.TaggedError("CollaborationRefused")<{
	readonly reason: string;
}> {
	override get message() {
		return this.reason;
	}
}

/** A bot in the workspace, by the name the model used. Any bot may ask any other, private ones included. */
const collaboratorNamed = (parent: schema.PlacedChatRow, name: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: bot.id, name: bot.name })
				.from(bot)
				.where(
					and(
						madeByPeople,
						eq(bot.workspaceId, parent.workspaceId),
						sql`lower(${bot.name}) = lower(${name.trim()})`,
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

/**
 * The bots waiting on `chatId` through collaborations, nearest first:
 * the bot that asked for it, the bot that asked for that one, and so on. One
 * per collaboration above it, so the count is how deep it nests. Each is read
 * from the asking turn, as a project people made has no one bot.
 */
const askersAboveOf = (chatId: string) =>
	Effect.map(
		query((db) =>
			db.execute<{ bot_id: string }>(
				sql`with recursive asked as (
					select ${collaboration.parentChatId} as parent_chat_id, ${turn.botId} as bot_id, 1 as depth
					from ${collaboration} join ${turn} on ${turn.id} = ${collaboration.turnId}
					where ${collaboration.chatId} = ${chatId}
					union all
					select ${collaboration.parentChatId}, ${turn.botId}, below.depth + 1
					from ${collaboration} join ${turn} on ${turn.id} = ${collaboration.turnId}
					join asked below on ${collaboration.chatId} = below.parent_chat_id
				)
				select bot_id from asked order by depth`,
				"objects",
			),
		),
		(rows) => rows.map((row) => row.bot_id),
	);

/**
 * Whether the turn already asked this collaborator. A turn may ask several
 * bots, but asking one twice only repeats a brief it could have
 * written once.
 */
const hasAskedThisTurn = (turnId: string, collaboratorId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: collaboration.id })
				.from(collaboration)
				.where(
					and(
						eq(collaboration.turnId, turnId),
						eq(collaboration.collaboratorBotId, collaboratorId),
					),
				)
				.limit(1),
		),
		([existing]) => existing !== undefined,
	);

function firstLine(text: string): string {
	const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return line.length <= MAX_CHAT_TITLE_CHARACTERS
		? line
		: `${line.slice(0, MAX_CHAT_TITLE_CHARACTERS - 1).trimEnd()}…`;
}

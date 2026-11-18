export * as Collaborations from "./collaborations.ts";

import type { CollaborationPart } from "@sugabots/contracts";
import { MAX_CONVERSATION_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import type { DomainEvents } from "../../../database/events/domain-events.ts";
import type * as schema from "../../../database/schema.ts";
import { bot, collaboration, placedConversation } from "../../../database/schema.ts";
import type { ConversationEvent } from "../../events.ts";
import { toCollaborationPart } from "../../repository/collaboration-parts.ts";
import { madeByPeople } from "../../repository/participants.ts";
import { ConversationRepository } from "../../repository/repository.ts";
import { lineageOf } from "../../repository/tree.ts";
import { makeRecords, type WaitOutcome } from "./repository.ts";

/**
 * Collaboration: one bot asking another for help.
 *
 * The asking bot's turn calls the `collaborate` tool mid-reply. That opens a
 * conversation of the collaborator's own, whose first message is the brief,
 * and records a collaboration pointing from the reply to that conversation. The
 * reply keeps a reference to the collaboration among its parts at the point
 * the call was made, so a reader sees the text before, the child conversation, and
 * the text after.
 */
export interface Interface {
	/**
	 * Opens the collaborator's conversation with the brief as its first message and
	 * records the collaboration; floor control asks for the collaborator's
	 * turn when it is opened. Fails, writing nothing, when policy refuses.
	 */
	readonly open: (input: {
		/** The asking bot's conversation, bot, turn, reply message, and how far into the reply it was. */
		from: {
			conversationId: string;
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
	 * Hands the collaborator's reply in its conversation `conversationId` back to the
	 * bot that asked, when it answers an outstanding brief. Floor control
	 * gives a bot that stopped waiting a turn in the parent conversation to pick
	 * the answer up. A reply with nothing outstanding is an ordinary message.
	 */
	readonly answer: (input: { conversationId: string; answer: string }) => Effect.Effect<void>;
	/**
	 * Fails a collaboration once its collaborator's turn in its conversation ends for
	 * good without answering: failed with no retry, cancelled, or given up
	 * on. An asking bot that stopped waiting gets a turn to say so, as it
	 * told the person it would follow up.
	 */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
	/**
	 * Fails the collaborations asked for in these conversations that are still
	 * waiting or pending, because the automation run they work for ended. One
	 * another transaction holds is skipped: its holder is moving it on.
	 */
	readonly failUnder: (conversationIds: readonly string[]) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Collaborations",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Collaborations");
	const conversations = yield* ConversationRepository.Service;
	const repository = yield* makeRecords;

	return Service.of({
		open: ({ from, to, brief }) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const [parent] = yield* query((db) =>
							db
								.select()
								.from(placedConversation)
								.where(eq(placedConversation.id, from.conversationId))
								.limit(1),
						);
						if (!parent) {
							return yield* new CollaborationRefused({
								reason: "This conversation no longer exists",
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
						const hostsAbove = yield* hostsAboveOf(parent.id);
						if (hostsAbove.length >= MAX_DEPTH) {
							return yield* new CollaborationRefused({
								reason: `Collaboration may only nest ${MAX_DEPTH} deep; answer this yourself`,
							});
						}
						if (hostsAbove.includes(collaborator.id)) {
							return yield* new CollaborationRefused({
								reason: `${collaborator.name} is already waiting on this conversation; answer it yourself`,
							});
						}
						if (yield* hasAskedThisTurn(from.turnId, collaborator.id)) {
							return yield* new CollaborationRefused({
								reason: `You have already asked ${collaborator.name} this turn; use what you were told`,
							});
						}

						const child = yield* conversations.openCollaboration({
							parent,
							askingBotId: from.botId,
							collaboratorId: collaborator.id,
							title: firstLine(brief),
							brief,
						});
						const opened = yield* repository.open({
							parentConversationId: parent.id,
							rootConversationId: parent.rootConversationId ?? parent.id,
							parentMessageId: from.messageId,
							turnId: from.turnId,
							conversationId: child.conversationId,
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
			operation("collectAnswer", repository.stopWaiting(collaborationId)),

		answer: ({ conversationId, answer }) =>
			operation("answer", transaction(repository.answer(conversationId, answer))),

		handler: (events) =>
			Effect.forEach(events.flatMap(unansweredBy), (ended) => repository.failUnanswered(ended), {
				discard: true,
			}),

		failUnder: repository.failUnder,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ConversationRepository.layer));

/** The collaborator whose turn in a collaboration's conversation the event ended without an answer. */
function unansweredBy(
	event: ConversationEvent,
): Array<{ readonly childConversationId: string; readonly collaboratorBotId: string }> {
	switch (event._tag) {
		case "TurnFailed":
			// A turn that runs again may still answer.
			return event.willRetry
				? []
				: [{ childConversationId: event.conversationId, collaboratorBotId: event.botId }];
		case "TurnCancelled":
		case "TurnAbandoned":
			return [{ childConversationId: event.conversationId, collaboratorBotId: event.botId }];
		default:
			return [];
	}
}

/** How deep collaboration may nest: a root conversation, a child, and a grandchild. */
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
const collaboratorNamed = (parent: schema.PlacedConversationRow, name: string) =>
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

/** Who hosts each conversation above `conversationId`, nearest first. */
const hostsAboveOf = (conversationId: string) =>
	Effect.map(
		query((db) =>
			db.execute<{ bot_id: string }>(
				sql`select lineage.bot_id from ${lineageOf(sql`${conversationId}`)} as lineage
					where lineage.depth > 0 order by lineage.depth`,
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
	return line.length <= MAX_CONVERSATION_TITLE_CHARACTERS
		? line
		: `${line.slice(0, MAX_CONVERSATION_TITLE_CHARACTERS - 1).trimEnd()}…`;
}

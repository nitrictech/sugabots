import {
	type ConversationKind,
	handleFromName,
	mentionedHandles,
	mentionsOnlyPeople,
} from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Executor, QueryFailure } from "../../database/database.ts";
import {
	bot,
	conversationParticipant,
	message,
	placedConversation,
	project,
	projectMember,
	type TurnReason,
	user,
} from "../../database/schema.ts";
import { inProject } from "../repository/participants.ts";

/** The message a person's message replies to. */
const repliedTo = alias(message, "replied_to");

/**
 * Who has the floor: which bots, if any, speak after a person's message.
 * A bot's message hands the floor to nobody: the person who asked reads
 * the answer and decides what happens next.
 *
 * The decision is a pure function of the message and the conversation, so it can be
 * read and tested on its own; `FloorControl.giveFloor` loads what it needs,
 * applies it, and asks for the turns. People post in three types of conversation:
 *
 * - A project's thread (`project_thread`), the same rule in every project, a
 *   bot's default project included:
 *   1. Mentioning the project's bots: each of them, taking a turn at once.
 *   2. Otherwise, replying to the message of one of the project's bots: that bot.
 *   3. Otherwise, mentioning only people: the lead bot reads it and may stay
 *      silent (an `optional` turn), as it may well be for them alone.
 *   4. Otherwise the lead bot.
 *   Mentions of bots outside the project are ignored, so in a bot's own
 *   threads, where it is the only bot, it always has the floor. A project
 *   with no lead yet has nobody to fall back on.
 * - An automation's feed (`automation_feed`), in the automation's project:
 *   1. Mentioning only people: nobody.
 *   2. Otherwise the project's lead bot, which runs the automation, whichever
 *      bots the person mentions: another bot they name is reached by the lead
 *      collaborating, not by joining. A project with no lead yet has nobody.
 * - A direct message between people: nobody.
 *
 * Only people's handles and `@here`/`@channel` count as mentioning people
 * (see `mentionsOnlyPeople`).
 */

export interface FloorInput {
	conversationKind: ConversationKind;
	/** What the message says, for mentions. */
	content: string;
	/** The bots addressable by handle: the project's bots, or none outside a project. */
	mentionableBots: ReadonlyArray<{ id: string; handle: string }>;
	/**
	 * In a project's thread or an automation's feed: the project's lead bot,
	 * one of `mentionableBots`, and whether it has a model, without which it is
	 * not offered a turn it may decline. Null in any other conversation, or a
	 * project with no lead yet.
	 */
	lead: { id: string; hasModel: boolean } | null;
	/** Handles of the people who may be mentioned here: the conversation's people and the project's members. */
	peopleHandles: ReadonlySet<string>;
	/** The bot that wrote the message this one replies to, if a bot did. */
	repliedToBotId: string | undefined;
}

type FloorDecision =
	| { kind: "turns"; bots: Array<{ botId: string; reason: TurnReason }> }
	| { kind: "nobody" };

const NOBODY: FloorDecision = { kind: "nobody" };

const turnFor = (botId: string, reason: TurnReason): FloorDecision => ({
	kind: "turns",
	bots: [{ botId, reason }],
});

export function decideFloor(input: FloorInput): FloorDecision {
	const mentioned = mentionedHandles(input.content);
	const mentionedBots = input.mentionableBots.filter((member) => mentioned.includes(member.handle));
	const forPeopleOnly = mentionsOnlyPeople(mentioned, {
		botHandles: new Set(input.mentionableBots.map((member) => member.handle)),
		peopleHandles: input.peopleHandles,
	});
	switch (input.conversationKind) {
		case "project_thread":
			return projectThreadFloor(input, mentionedBots, forPeopleOnly);
		case "automation_feed":
			if (input.lead === null || forPeopleOnly) return NOBODY;
			return turnFor(
				input.lead.id,
				mentionedBots.some((member) => member.id === input.lead?.id) ? "mention" : "default",
			);
		default:
			return NOBODY;
	}
}

function projectThreadFloor(
	input: FloorInput,
	mentionedBots: ReadonlyArray<{ id: string }>,
	forPeopleOnly: boolean,
): FloorDecision {
	if (mentionedBots.length > 0) {
		return {
			kind: "turns",
			bots: mentionedBots.map((member) => ({ botId: member.id, reason: "mention" })),
		};
	}
	const repliedTo = input.mentionableBots.find((member) => member.id === input.repliedToBotId);
	if (repliedTo) return turnFor(repliedTo.id, "reply");
	const { lead } = input;
	if (lead === null) return NOBODY;
	if (!forPeopleOnly) return turnFor(lead.id, "default");
	// An optional turn the lead could not take would only post its failure.
	return lead.hasModel ? turnFor(lead.id, "optional") : NOBODY;
}

/** A person's message, committed, that somebody may answer. */
export interface FloorMessage {
	id: string;
	conversationId: string;
	content: string;
}

/**
 * What `decideFloor` needs from the database, for one conversation and message.
 *
 * `mentionableBots` is every bot added to the project, and none outside a project,
 * where nobody gets the floor; not the conversation's participants: a person may mention
 * a bot that has not joined the conversation yet, and reading the mention against
 * who is already in it would leave every first mention unrecognised. People
 * are read the same way: the project's members, and anyone in the conversation who
 * no longer is one.
 */
export const loadFloorScope = Effect.fn("Floor.loadFloorScope")(function* (
	db: Executor,
	committed: FloorMessage,
): Effect.fn.Return<Omit<FloorInput, "content">, QueryFailure> {
	// One round trip: the project's bots and the people ride along as JSON beside the conversation.
	const [scope] = yield* db
		.select({
			conversationKind: placedConversation.kind,
			lead: sql<{ id: string; hasModel: boolean } | null>`(
				select json_build_object('id', ${bot.id}, 'hasModel', ${bot.model} is not null)
				from ${project}
				inner join ${bot} on ${bot.id} = ${project.leadBotId}
				where ${project.id} = ${placedConversation.projectId}
			)`,
			mentionableBots: sql<Array<{ id: string; handle: string }>>`(
				select coalesce(json_agg(json_build_object('id', ${bot.id}, 'handle', ${bot.handle})), '[]'::json)
				from ${bot}
				where ${inProject(placedConversation.projectId)}
			)`,
			// Not only the project's members: people who left the project stay in its
			// conversations, and can still be mentioned there.
			peopleNames: sql<string[]>`(
				select coalesce(json_agg(${user.name}), '[]'::json)
				from ${user}
				where ${user.id} in (
					select ${projectMember.userId} from ${projectMember} where ${projectMember.projectId} = ${placedConversation.projectId}
					union
					select ${conversationParticipant.userId} from ${conversationParticipant} where ${conversationParticipant.conversationId} = ${placedConversation.id}
				)
			)`,
			repliedToBotId: sql<string | null>`(${db
				.select({ authorBotId: repliedTo.authorBotId })
				.from(message)
				.innerJoin(repliedTo, eq(repliedTo.id, message.replyToMessageId))
				.where(eq(message.id, committed.id))})`,
		})
		.from(placedConversation)
		.where(eq(placedConversation.id, committed.conversationId))
		.limit(1);
	if (!scope) {
		throw new Error("The conversation this message is in no longer exists");
	}
	return {
		conversationKind: scope.conversationKind,
		lead: scope.lead,
		mentionableBots: scope.mentionableBots,
		peopleHandles: new Set(scope.peopleNames.map(handleFromName)),
		repliedToBotId: scope.repliedToBotId ?? undefined,
	};
});

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
	channelMember,
	conversationParticipant,
	message,
	placedConversation,
	type TurnReason,
	user,
} from "../../database/schema.ts";
import { inChannel, madeByPeople } from "../repository/participants.ts";

/** The message a person's message replies to. */
const repliedTo = alias(message, "replied_to");

/**
 * Who has the floor: which bot, if any, speaks after a person's message.
 * A bot's message hands the floor to nobody: the person who asked reads
 * the answer and decides what happens next.
 *
 * The decision is a pure function of the message and the conversation, so it can be
 * read and tested on its own; `FloorControl.giveFloor` loads what it needs,
 * applies it, and asks for the turns. People post in three types of conversation:
 *
 * - A channel's main chat or thread (`channel_conversation`), where bots reply only when asked:
 *   1. Mentioning bots: every bot it mentions, each taking a turn at once.
 *   2. Otherwise, replying to a bot's message: that bot, though it mentions only people.
 *   3. Otherwise nobody, as its people talk to each other.
 * - A bot's task (`task`) or an automation's feed (`automation_feed`):
 *   1. Mentioning only people: nobody.
 *   2. Otherwise its bot, whichever bots the person mentions. The conversation is
 *      that bot's, so another bot the person names is reached by that bot
 *      collaborating, not by joining.
 *
 * Only people's handles and `@here`/`@channel` count as mentioning people
 * (see `mentionsOnlyPeople`).
 */

export interface FloorInput {
	conversationKind: ConversationKind;
	/** What the message says, for mentions. */
	content: string;
	/** The bot the conversation is with; null in a channel or a direct message. */
	conversationBotId: string | null;
	/** The bots addressable by handle: a channel's bots, or else every bot in the workspace. */
	mentionableBots: ReadonlyArray<{ id: string; handle: string }>;
	/** Handles of the people who may be mentioned here: the conversation's people and the channel's members. */
	peopleHandles: ReadonlySet<string>;
	/** The bot that wrote the message this one replies to, if a bot did. */
	repliedToBotId: string | undefined;
}

export type FloorDecision =
	| { kind: "turns"; bots: Array<{ botId: string; reason: TurnReason }> }
	| { kind: "nobody" };

const NOBODY: FloorDecision = { kind: "nobody" };

export function decideFloor(input: FloorInput): FloorDecision {
	const mentioned = mentionedHandles(input.content);
	const mentionedBots = input.mentionableBots.filter((member) => mentioned.includes(member.handle));
	const forPeopleOnly = mentionsOnlyPeople(mentioned, {
		botHandles: new Set(input.mentionableBots.map((member) => member.handle)),
		peopleHandles: input.peopleHandles,
	});
	if (input.conversationKind === "channel_conversation") {
		if (mentionedBots.length > 0) {
			return {
				kind: "turns",
				bots: mentionedBots.map((member) => ({ botId: member.id, reason: "mention" })),
			};
		}
		const repliedTo = input.mentionableBots.find((member) => member.id === input.repliedToBotId);
		return repliedTo ? { kind: "turns", bots: [{ botId: repliedTo.id, reason: "reply" }] } : NOBODY;
	}
	const { conversationBotId } = input;
	if (conversationBotId === null || forPeopleOnly) return NOBODY;
	if (input.conversationKind !== "task" && input.conversationKind !== "automation_feed")
		return NOBODY;
	const reason = mentionedBots.some((member) => member.id === conversationBotId)
		? "mention"
		: "default";
	return { kind: "turns", bots: [{ botId: conversationBotId, reason }] };
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
 * `mentionableBots` is every bot added to the channel, or outside a channel every bot in
 * the workspace, rather than the conversation's participants: a person may mention
 * a bot that has not joined the conversation yet, and reading the mention against
 * who is already in it would leave every first mention unrecognised. People
 * are read the same way: the channel's members, and anyone in the conversation who
 * no longer is one.
 */
export const loadFloorScope = Effect.fn("Floor.loadFloorScope")(function* (
	db: Executor,
	committed: FloorMessage,
): Effect.fn.Return<Omit<FloorInput, "content">, QueryFailure> {
	// One round trip: the mentionableBots and the people ride along as JSON beside the conversation.
	const [scope] = yield* db
		.select({
			conversationBotId: placedConversation.botId,
			conversationKind: placedConversation.kind,
			mentionableBots: sql<Array<{ id: string; handle: string }>>`(
				select coalesce(json_agg(json_build_object('id', ${bot.id}, 'handle', ${bot.handle})), '[]'::json)
				from ${bot}
				where case when ${placedConversation.channelId} is null
					then ${bot.workspaceId} = ${placedConversation.workspaceId} and ${madeByPeople}
					else ${inChannel(placedConversation.channelId)} end
			)`,
			// Not only the channel's members: people who left the channel stay in its
			// conversations, and can still be mentioned there.
			peopleNames: sql<string[]>`(
				select coalesce(json_agg(${user.name}), '[]'::json)
				from ${user}
				where ${user.id} in (
					select ${channelMember.userId} from ${channelMember} where ${channelMember.channelId} = ${placedConversation.channelId}
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
		conversationBotId: scope.conversationBotId,
		mentionableBots: scope.mentionableBots,
		peopleHandles: new Set(scope.peopleNames.map(handleFromName)),
		repliedToBotId: scope.repliedToBotId ?? undefined,
	};
});

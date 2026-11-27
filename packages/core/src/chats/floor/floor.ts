import {
	type AddressedMessage,
	type ChatKind,
	decideFloor,
	type Floor,
	handleFromName,
	mentionedHandles,
	mentionsOnlyMembers,
} from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { membersReachingProject } from "../../authorization/access.ts";
import type { Executor, QueryFailure } from "../../database/database.ts";
import {
	bot,
	chatParticipant,
	member,
	message,
	placedChat,
	project,
	type TurnReason,
	turn,
} from "../../database/schema.ts";
import { inProject } from "../store/participants.ts";

/** The message a member's message replies to. */
const repliedTo = alias(message, "replied_to");

/**
 * Who has the floor after a member's message: `decideFloor`'s rule, applied
 * to what the message says. A bot's message hands the floor only to the bots
 * it asks for help (`helpersAskedBy`, read against `loadRepliedTurn`).
 * `FloorControl.giveFloor` loads what it needs (`loadFloorScope`), applies it,
 * and asks for the turns.
 *
 * Only the project's bots' handles count as mentioning bots, and only members'
 * handles and `@here`/`@channel` as mentioning members (see `mentionsOnlyMembers`).
 */
export function floorOf(input: FloorInput): Floor {
	const mentioned = mentionedHandles(input.content);
	const mentionedBots = input.mentionableBots.filter((one) => mentioned.includes(one.handle));
	return decideFloor({
		chatKind: input.chatKind,
		lead: input.lead,
		mentionedBotIds: mentionedBots.map((one) => one.id),
		repliedToProjectBotId: input.mentionableBots.find((one) => one.id === input.repliedToBotId)?.id,
		membersOnly: mentionsOnlyMembers(mentioned, {
			botHandles: new Set(input.mentionableBots.map((one) => one.handle)),
			membersHandles: input.membersHandles,
		}),
	});
}

/** What `floorOf` reads a member's message against; `lead` is one of `mentionableBots`. */
export interface FloorInput extends Pick<AddressedMessage, "chatKind" | "lead"> {
	/** What the message says, for mentions. */
	content: string;
	/** The bots addressable by handle: the project's bots, or none outside a project. */
	mentionableBots: ReadonlyArray<{ id: string; handle: string }>;
	/**
	 * Handles of the members who may be mentioned here: those who reach the
	 * project (see `membersReachingProject`), and the chat's participants.
	 */
	membersHandles: ReadonlySet<string>;
	/** The bot that wrote the message this one replies to, if a bot did. */
	repliedToBotId: string | undefined;
}

/** A member's message, committed, that somebody may answer. */
export interface FloorMessage {
	id: string;
	chatId: string;
	content: string;
}

/** What `floorOf` needs, with whether each of the project's bots has a model. */
interface FloorScope extends Omit<FloorInput, "content"> {
	mentionableBots: ReadonlyArray<{ id: string; handle: string; hasModel: boolean }>;
}

/**
 * What `floorOf` needs from the database, for one chat and message.
 *
 * `mentionableBots` is every bot added to the project, and none outside a project,
 * where nobody gets the floor; not the chat's participants: a member may mention
 * a bot that has not joined the chat yet, and reading the mention against
 * who is already in it would leave every first mention unrecognised. Members
 * are read the same way, as the chat's details list them for mentions:
 * everyone who reaches the project (`membersReachingProject`), and anyone in the
 * chat who no longer does.
 */
export const loadFloorScope = Effect.fn("Floor.loadFloorScope")(function* (
	db: Executor,
	committed: FloorMessage,
): Effect.fn.Return<FloorScope, QueryFailure> {
	// One round trip: the project's bots and the members ride along as JSON beside the chat.
	const [scope] = yield* db
		.select({
			chatKind: placedChat.kind,
			leadBotId: sql<string | null>`(
				select ${project.leadBotId} from ${project} where ${project.id} = ${placedChat.projectId}
			)`,
			mentionableBots: sql<Array<{ id: string; handle: string; hasModel: boolean }>>`(
				select coalesce(json_agg(json_build_object('id', ${bot.id}, 'handle', ${bot.handle}, 'hasModel', ${bot.model} is not null)), '[]'::json)
				from ${bot}
				where ${inProject(placedChat.projectId)}
			)`,
			// Not only those who reach the project: members who left it stay in its
			// chats, and can still be mentioned there.
			membersNames: sql<string[]>`(
				select coalesce(json_agg(${member.name}), '[]'::json)
				from ${member}
				where ${member.id} in (
					${membersReachingProject(placedChat.projectId)}
					union
					select ${chatParticipant.memberId} from ${chatParticipant} where ${chatParticipant.chatId} = ${placedChat.id}
				)
			)`,
			repliedToBotId: sql<string | null>`(${db
				.select({ authorBotId: repliedTo.authorBotId })
				.from(message)
				.innerJoin(repliedTo, eq(repliedTo.id, message.replyToMessageId))
				.where(eq(message.id, committed.id))})`,
		})
		.from(placedChat)
		.where(eq(placedChat.id, committed.chatId))
		.limit(1);
	if (!scope) {
		return yield* Effect.die(new Error("The chat this message is in no longer exists"));
	}
	// A project's lead is always one of its bots (see `ProjectStore`).
	const lead = scope.mentionableBots.find((one) => one.id === scope.leadBotId);
	return {
		chatKind: scope.chatKind,
		lead: lead ? { id: lead.id, hasModel: lead.hasModel } : null,
		mentionableBots: scope.mentionableBots,
		membersHandles: new Set(scope.membersNames.map(handleFromName)),
		repliedToBotId: scope.repliedToBotId ?? undefined,
	};
});

/** The turn that wrote a bot's reply, and what `helpersAskedBy` reads the reply against. */
interface RepliedTurn {
	reason: TurnReason | null;
	/** The message the turn answered: for a helper's turn, the message that asked it. */
	triggerMessageId: string;
	chatKind: ChatKind;
	/** The bots of the chat's project with a model, which a reply may ask; none outside a project. */
	modelledBots: ReadonlyArray<{ id: string; handle: string }>;
}

/** The turn `turnId`, as `RepliedTurn` reads it; undefined once it is gone. */
export const loadRepliedTurn = Effect.fn("Floor.loadRepliedTurn")(function* (
	db: Executor,
	turnId: string,
): Effect.fn.Return<RepliedTurn | undefined, QueryFailure> {
	const [row] = yield* db
		.select({
			reason: turn.reason,
			triggerMessageId: turn.triggerMessageId,
			chatKind: placedChat.kind,
			modelledBots: sql<Array<{ id: string; handle: string }>>`(
				select coalesce(json_agg(json_build_object('id', ${bot.id}, 'handle', ${bot.handle})), '[]'::json)
				from ${bot}
				where ${inProject(placedChat.projectId)} and ${bot.model} is not null
			)`,
		})
		.from(turn)
		.innerJoin(placedChat, eq(placedChat.id, turn.chatId))
		.where(eq(turn.id, turnId))
		.limit(1);
	return row;
});

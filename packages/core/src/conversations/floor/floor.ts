import {
	handleFromName,
	mentionedHandles,
	mentionsOnlyPeople,
	type ThreadType,
} from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Executor, QueryFailure } from "../../database/database.ts";
import {
	agent,
	message,
	podMember,
	type TurnReason,
	thread,
	threadParticipant,
	user,
} from "../../database/schema.ts";
import { crewAgent, inChannel } from "../threads/participants.ts";

/** The message a person's message replies to. */
const repliedTo = alias(message, "replied_to");

/**
 * Who has the floor: which agent, if any, speaks after a person's message.
 * An agent's message hands the floor to nobody: the person who asked reads
 * the answer and decides what happens next.
 *
 * The decision is a pure function of the message and the thread, so it can be
 * read and tested on its own; `FloorControl.giveFloor` loads what it needs,
 * applies it, and asks for the turns. People post in three types of thread:
 *
 * - A channel's chat or thread (`pod_chat`), where bots reply only when asked:
 *   1. Mentioning anyone: every bot it mentions, each taking a turn at once.
 *   2. Otherwise, replying to a bot's message: that bot.
 *   3. Otherwise nobody, as its people talk to each other.
 * - A bot's task (`conversation`) or an automation's thread (`routine_feed`):
 *   1. Mentioning only people: nobody.
 *   2. Otherwise its bot, whichever bots the person mentions. The thread is
 *      that bot's, so another bot the person names is reached by that bot
 *      collaborating, not by joining.
 *
 * Only people's handles and `@here`/`@channel` count as mentioning people
 * (see `mentionsOnlyPeople`).
 */

export interface FloorInput {
	threadType: ThreadType;
	/** What the message says, for mentions. */
	content: string;
	/** The bot the thread is with; null in a channel or a direct message. */
	hostAgentId: string | null;
	/** The bots addressable by handle: a channel's bots, or else every bot in the workspace. */
	crew: ReadonlyArray<{ id: string; handle: string }>;
	/** Handles of the people who may be mentioned here: the thread's people and the channel's members. */
	peopleHandles: ReadonlySet<string>;
	/** The agent that wrote the message this one replies to, if an agent did. */
	repliedToAgentId: string | undefined;
}

export type FloorDecision =
	| { kind: "turns"; agents: Array<{ agentId: string; reason: TurnReason }> }
	| { kind: "nobody" };

const NOBODY: FloorDecision = { kind: "nobody" };

export function decideFloor(input: FloorInput): FloorDecision {
	const mentioned = mentionedHandles(input.content);
	const mentionedAgents = input.crew.filter((member) => mentioned.includes(member.handle));
	const forPeopleOnly = mentionsOnlyPeople(mentioned, {
		botHandles: new Set(input.crew.map((member) => member.handle)),
		peopleHandles: input.peopleHandles,
	});
	if (input.threadType === "pod_chat") {
		if (mentionedAgents.length > 0) {
			return {
				kind: "turns",
				agents: mentionedAgents.map((member) => ({ agentId: member.id, reason: "mention" })),
			};
		}
		const repliedTo = input.crew.find((member) => member.id === input.repliedToAgentId);
		return repliedTo && !forPeopleOnly
			? { kind: "turns", agents: [{ agentId: repliedTo.id, reason: "reply" }] }
			: NOBODY;
	}
	const { hostAgentId } = input;
	if (hostAgentId === null || forPeopleOnly) return NOBODY;
	if (input.threadType !== "conversation" && input.threadType !== "routine_feed") return NOBODY;
	const reason = mentionedAgents.some((member) => member.id === hostAgentId)
		? "mention"
		: "default";
	return { kind: "turns", agents: [{ agentId: hostAgentId, reason }] };
}

/** A person's message, committed, that somebody may answer. */
export interface FloorMessage {
	id: string;
	threadId: string;
	content: string;
}

/**
 * What `decideFloor` needs from the database, for one thread and message.
 *
 * `crew` is every bot added to the channel, or outside a channel every bot in
 * the workspace, rather than the thread's participants: a person may mention
 * a bot that has not joined the thread yet, and reading the mention against
 * who is already in it would leave every first mention unrecognised. People
 * are read the same way: the channel's members, and anyone in the thread who
 * no longer is one.
 */
export const loadFloorScope = Effect.fn("Floor.loadFloorScope")(function* (
	db: Executor,
	committed: FloorMessage,
): Effect.fn.Return<Omit<FloorInput, "content">, QueryFailure> {
	// One round trip: the crew and the people ride along as JSON beside the thread.
	const [scope] = yield* db
		.select({
			hostAgentId: thread.hostAgentId,
			threadType: thread.type,
			crew: sql<Array<{ id: string; handle: string }>>`(
				select coalesce(json_agg(json_build_object('id', ${agent.id}, 'handle', ${agent.handle})), '[]'::json)
				from ${agent}
				where case when ${thread.podId} is null
					then ${agent.workspaceId} = ${thread.workspaceId} and ${crewAgent}
					else ${inChannel(thread.podId)} end
			)`,
			// Not only the channel's members: people who left the channel stay in its
			// threads, and can still be mentioned there.
			peopleNames: sql<string[]>`(
				select coalesce(json_agg(${user.name}), '[]'::json)
				from ${user}
				where ${user.id} in (
					select ${podMember.userId} from ${podMember} where ${podMember.podId} = ${thread.podId}
					union
					select ${threadParticipant.userId} from ${threadParticipant} where ${threadParticipant.threadId} = ${thread.id}
				)
			)`,
			repliedToAgentId: sql<string | null>`(${db
				.select({ authorAgentId: repliedTo.authorAgentId })
				.from(message)
				.innerJoin(repliedTo, eq(repliedTo.id, message.replyToMessageId))
				.where(eq(message.id, committed.id))})`,
		})
		.from(thread)
		.where(eq(thread.id, committed.threadId))
		.limit(1);
	if (!scope) {
		throw new Error("The thread this message is in no longer exists");
	}
	return {
		threadType: scope.threadType,
		hostAgentId: scope.hostAgentId,
		crew: scope.crew,
		peopleHandles: new Set(scope.peopleNames.map(handleFromName)),
		repliedToAgentId: scope.repliedToAgentId ?? undefined,
	};
});

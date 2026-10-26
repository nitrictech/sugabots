import { mentionedHandles, type ThreadType } from "@sugabots/contracts";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor, QueryFailure } from "../../database/database.ts";
import {
	agent,
	message,
	type TurnReason,
	thread,
	threadParticipant,
} from "../../database/schema.ts";
import { crewOf } from "../threads/participants.ts";

/**
 * Who has the floor: which agent, if any, speaks after a person's message.
 * An agent's message hands the floor to nobody: the person who asked reads
 * the answer and decides what happens next.
 *
 * The decision is a pure function of the message and the thread, so it can be
 * read and tested on its own; `FloorControl.giveFloor` loads what it needs,
 * applies it, and asks for the turns. People post in three types of thread:
 *
 * - A pod's chat: nobody. Its people talk to each other, and start a thread
 *   to ask a bot.
 * - A conversation (`conversation`), with a bot or between people:
 *   1. Between people, or mentioning only people: nobody.
 *   2. With other people in it: its bot when they mention it, otherwise
 *      nobody. They talk to each other until they call it.
 *   3. Otherwise its bot, whichever bots they mention. A conversation is with
 *      one bot, so another bot the person names is reached by that bot
 *      collaborating, not by joining.
 * - A routine's thread (`routine_feed`):
 *   1. Mentioning only people: nobody.
 *   2. Mentioning bots by handle: those bots, and nobody else.
 *   3. Otherwise the bot that spoke last, else the routine's own.
 */

export interface FloorInput {
	threadType: ThreadType;
	/** How many people are in the thread, the writer included. */
	peopleInThread: number;
	/** What the message says, for mentions. */
	content: string;
	/** The bot the thread is with; null in a pod's chat or between people. */
	hostAgentId: string | null;
	/** Crew placed in the pod, addressable by handle. */
	crew: ReadonlyArray<{ id: string; handle: string }>;
	/** Agents already in the thread. */
	agentParticipantIds: ReadonlySet<string>;
	/** The agent that completed the last message before this one, if an agent did. */
	lastAgentSpeakerId: string | undefined;
}

export type FloorDecision =
	| { kind: "turns"; agents: Array<{ agentId: string; reason: TurnReason }> }
	| { kind: "nobody" };

const NOBODY: FloorDecision = { kind: "nobody" };

export function decideFloor(input: FloorInput): FloorDecision {
	const mentioned = mentionedHandles(input.content);
	const mentionedAgents = input.crew.filter((member) => mentioned.includes(member.handle));
	const mentionsOnlyPeople = mentioned.length > 0 && mentionedAgents.length === 0;
	const { hostAgentId } = input;
	if (hostAgentId === null || mentionsOnlyPeople) return NOBODY;
	switch (input.threadType) {
		case "conversation":
			if (input.peopleInThread <= 1) {
				return { kind: "turns", agents: [{ agentId: hostAgentId, reason: "default" }] };
			}
			return mentionedAgents.some((member) => member.id === hostAgentId)
				? { kind: "turns", agents: [{ agentId: hostAgentId, reason: "mention" }] }
				: NOBODY;
		case "routine_feed": {
			if (mentionedAgents.length > 0) {
				return {
					kind: "turns",
					agents: mentionedAgents.map((member) => ({ agentId: member.id, reason: "mention" })),
				};
			}
			const fallback =
				input.lastAgentSpeakerId && input.agentParticipantIds.has(input.lastAgentSpeakerId)
					? input.lastAgentSpeakerId
					: hostAgentId;
			return { kind: "turns", agents: [{ agentId: fallback, reason: "default" }] };
		}
		default:
			return NOBODY;
	}
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
 * `crew` is the pod's whole crew rather than the thread's participants: a
 * person may mention an agent who has not joined the thread yet, and reading
 * the mention against who is already in it would leave every first mention
 * unrecognised.
 */
export const loadFloorScope = Effect.fn("Floor.loadFloorScope")(function* (
	db: Executor,
	committed: FloorMessage,
): Effect.fn.Return<Omit<FloorInput, "content">, QueryFailure> {
	// One round trip: the crew, the participants and the last speaker ride
	// along as JSON beside the thread.
	const [scope] = yield* db
		.select({
			hostAgentId: thread.hostAgentId,
			threadType: thread.type,
			crew: sql<Array<{ id: string; handle: string }>>`(
				select coalesce(json_agg(json_build_object('id', ${agent.id}, 'handle', ${agent.handle})), '[]'::json)
				from ${agent}
				where ${crewOf(thread.podId)}
			)`,
			participantAgentIds: sql<string[]>`(
				select coalesce(json_agg(${threadParticipant.agentId}) filter (where ${threadParticipant.agentId} is not null), '[]'::json)
				from ${threadParticipant}
				where ${threadParticipant.threadId} = ${thread.id}
			)`,
			peopleInThread: sql<number>`(
				select count(*)::int from ${threadParticipant}
				where ${threadParticipant.threadId} = ${thread.id} and ${threadParticipant.userId} is not null
			)`,
			lastAgentSpeakerId: sql<string | null>`(
				select ${message.authorAgentId}
				from ${message}
				where ${message.threadId} = ${thread.id}
					and ${message.status} = 'complete'
					and ${message.id} <> ${committed.id}
				order by ${message.createdAt} desc, ${message.id} desc
				limit 1
			)`,
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
		agentParticipantIds: new Set(scope.participantAgentIds),
		peopleInThread: scope.peopleInThread,
		lastAgentSpeakerId: scope.lastAgentSpeakerId ?? undefined,
	};
});

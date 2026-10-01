import { mentionedHandles, type PodRouting, type ThreadType } from "@sugabots/contracts";
import { eq, type SQLWrapper, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor, QueryFailure } from "../../database/database.ts";
import {
	agent,
	message,
	pod,
	type TurnReason,
	thread,
	threadParticipant,
} from "../../database/schema.ts";
import { laneBusy } from "../../workflows/lanes.ts";
import { crewOf } from "../threads/participants.ts";
import { Turns } from "../turns/turns.ts";
import { Facilitate } from "./facilitate.workflow.ts";

/**
 * Who has the floor: which agent, if any, speaks after a message.
 *
 * The decision is a pure function of the message and the thread, so it can be
 * read and tested on its own; `FloorControl.giveFloor` loads what it needs,
 * applies it, and asks for the turns. Precedence, top wins:
 *
 * 1. A person writing for people only, or mentioning only people: nobody.
 *    They are talking to each other.
 * 2. A person writing in a chat: the chat's agent, whichever agents they
 *    mention. A chat is a conversation with one agent, so another agent the
 *    person names is reached by that agent collaborating, not by joining.
 * 3. A person mentioning agents by handle: those agents, and nobody else.
 * 4. An agent that a person named, having answered: nobody. The mention chose
 *    who speaks, so the reply goes back to the person who asked.
 * 5. The Facilitator in non-chat threads, when the pod has it on.
 * 6. Default: the agent that spoke last, else the host.
 *
 * An agent's message that calls nobody out ends the exchange, the way a model
 * turn with no tool call ends an agentic loop. A run of agent-only turns longer
 * than any real exchange needs is paused, and the people get the floor.
 */

/** Consecutive agent turns without a person speaking before the floor is handed back. */
export const MAX_AGENT_RUN = 12;

export interface FloorInput {
	routing: PodRouting;
	threadType: ThreadType;
	author:
		| {
				kind: "person";
				/** Written for the other people, so no bot replies. */
				peopleOnly: boolean;
		  }
		| {
				kind: "agent";
				agentId: string;
				/** Why this agent had the floor, which decides who gets it back. */
				spokeBecause: TurnReason | undefined;
		  };
	/** What the message says, for mentions. */
	content: string;
	hostAgentId: string;
	/** Crew placed in the pod, addressable by handle. */
	crew: ReadonlyArray<{ id: string; handle: string }>;
	/** Agents already in the thread. */
	agentParticipantIds: ReadonlySet<string>;
	/** The agent that completed the last message before this one, if an agent did. */
	lastAgentSpeakerId: string | undefined;
	/** Agent messages in a row up to and including this one, since a person last spoke. */
	agentRun: number;
}

export type FloorDecision =
	| { kind: "turns"; agents: Array<{ agentId: string; reason: TurnReason }> }
	| { kind: "facilitate" }
	| {
			kind: "nobody";
			why: "people-addressed" | "answered-the-person" | "exchange-over" | "paused";
	  };

export function decideFloor(input: FloorInput): FloorDecision {
	if (input.author.kind === "person") {
		const mentioned = mentionedHandles(input.content);
		const mentionedAgents = input.crew.filter((member) => mentioned.includes(member.handle));
		if (input.author.peopleOnly || (mentioned.length > 0 && mentionedAgents.length === 0)) {
			return { kind: "nobody", why: "people-addressed" };
		}
		if (input.threadType === "chat") {
			return { kind: "turns", agents: [{ agentId: input.hostAgentId, reason: "default" }] };
		}
		if (mentionedAgents.length > 0) {
			return {
				kind: "turns",
				agents: mentionedAgents.map((member) => ({ agentId: member.id, reason: "mention" })),
			};
		}
		if (input.routing.facilitator && input.agentParticipantIds.size > 1) {
			return { kind: "facilitate" };
		}
		const fallback =
			input.lastAgentSpeakerId && input.agentParticipantIds.has(input.lastAgentSpeakerId)
				? input.lastAgentSpeakerId
				: input.hostAgentId;
		return { kind: "turns", agents: [{ agentId: fallback, reason: "default" }] };
	}

	if (input.agentRun >= MAX_AGENT_RUN) {
		return { kind: "nobody", why: "paused" };
	}
	// A person named this agent and it has answered without handing on. The
	// answer belongs to the person who asked: mentioning one agent means that
	// agent and nobody else, and that holds for the reply as much as the turn.
	if (input.author.spokeBecause === "mention") {
		return { kind: "nobody", why: "answered-the-person" };
	}
	if (input.threadType !== "chat" && input.routing.facilitator) {
		return { kind: "facilitate" };
	}
	return { kind: "nobody", why: "exchange-over" };
}

export interface FloorMessage {
	id: string;
	threadId: string;
	content: string;
	author: FloorInput["author"];
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
): Effect.fn.Return<Omit<FloorInput, "content" | "author">, QueryFailure> {
	// One round trip: the crew, the participants and the recent messages ride
	// along as JSON beside the thread.
	const [scope] = yield* db
		.select({
			hostAgentId: thread.hostAgentId,
			routing: pod.routing,
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
			// Newest first, this message included: how long agents have been
			// talking among themselves, and who among them spoke last.
			recent: sql<Array<{ id: string; authorAgentId: string | null }>>`(
				select coalesce(json_agg(json_build_object('id', recent.id, 'authorAgentId', recent.author_agent_id) order by recent.created_at desc, recent.id desc), '[]'::json)
				from (
					select ${message.id} as id, ${message.authorAgentId} as author_agent_id, ${message.createdAt} as created_at
					from ${message}
					where ${message.threadId} = ${thread.id} and ${message.status} = 'complete'
					order by ${message.createdAt} desc, ${message.id} desc
					limit ${MAX_AGENT_RUN + 1}
				) as recent
			)`,
		})
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.where(eq(thread.id, committed.threadId))
		.limit(1);
	if (!scope) {
		throw new Error("The thread this message is in no longer exists");
	}
	const recent = scope.recent;

	let agentRun = 0;
	for (const row of recent) {
		if (!row.authorAgentId) break;
		agentRun += 1;
	}
	const previous = recent.find((row) => row.id !== committed.id);

	return {
		routing: scope.routing,
		threadType: scope.threadType,
		hostAgentId: scope.hostAgentId,
		crew: scope.crew,
		agentParticipantIds: new Set(scope.participantAgentIds),
		lastAgentSpeakerId: previous?.authorAgentId ?? undefined,
		agentRun,
	};
});

/**
 * respondingIn reports, as a condition for a query, whether an agent is
 * answering in the thread `threadId` or about to: its turn is running or
 * waiting to start, or the Facilitator is choosing who speaks.
 */
export const respondingIn = (threadId: SQLWrapper) =>
	sql<boolean>`(${Turns.busyIn(threadId)} or ${laneBusy(threadId, [Facilitate._tag])})`;

import {
	mentionedHandles,
	type PodRouting,
	streamEvent,
	type ThreadType,
	threadChannel,
} from "@sugabots/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
	type Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../../database/database.ts";
import type { PublishEvents } from "../../database/events/publish.ts";
import {
	agent,
	message,
	pod,
	type TurnReason,
	thread,
	threadParticipant,
} from "../../database/schema.ts";
import { enqueueJob } from "../jobs/queue.ts";
import { queueTurn } from "./queue.ts";

/**
 * Who has the floor: which agent, if any, speaks after a message (ADR 004).
 *
 * The decision is a pure function of the message and the thread, so it can be
 * read and tested on its own; `giveFloor` loads what it needs, applies it, and
 * queues the turns. Precedence, top wins:
 *
 * 1. A person writing in a chat: the chat's agent, whoever they mention. A
 *    chat is a conversation with one agent, so another agent the person names
 *    is reached by that agent collaborating, not by joining the chat.
 * 2. A person mentioning agents by handle: those agents, and nobody else.
 * 3. An agent that a person named, having answered: nobody. The mention chose
 *    who speaks, so the reply goes back to the person who asked.
 * 4. The Facilitator in non-chat threads, when the pod has it on.
 * 5. Default: the agent that spoke last, else the host.
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
		| { kind: "person" }
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
		if (input.threadType === "chat") {
			return { kind: "turns", agents: [{ agentId: input.hostAgentId, reason: "default" }] };
		}
		const mentioned = mentionedHandles(input.content);
		if (mentioned.length > 0) {
			const agents = input.crew
				.filter((member) => mentioned.includes(member.handle))
				.map((member) => ({ agentId: member.id, reason: "mention" as const }));
			return agents.length > 0
				? { kind: "turns", agents }
				: { kind: "nobody", why: "people-addressed" };
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
 * Applies the decision for a committed message: queues the turns or the
 * router job, and brings any newly addressed crew agent into the thread as a
 * participant. Runs in the caller's transaction, so it commits with the message.
 */
export const giveFloor = (
	publishEvents: PublishEvents,
	committed: FloorMessage,
): Effect.Effect<FloorDecision, never, Database> =>
	transaction(
		Effect.gen(function* () {
			const scope = yield* query((db) => loadFloorScope(db, committed));
			const decision = decideFloor({
				...scope,
				content: committed.content,
				author: committed.author,
			});

			if (decision.kind === "facilitate") {
				yield* enqueueJob({
					kind: "facilitate",
					threadId: committed.threadId,
					payload: { triggerMessageId: committed.id },
					dedupeKey: `route:${committed.threadId}`,
					ifAlreadyQueued: "replacePayload",
				});
				return decision;
			}
			if (decision.kind !== "turns") {
				return decision;
			}

			const joining = decision.agents.filter(
				({ agentId }) => !scope.agentParticipantIds.has(agentId),
			);
			if (joining.length > 0) {
				yield* query((db) =>
					db
						.insert(threadParticipant)
						.values(joining.map(({ agentId }) => ({ threadId: committed.threadId, agentId })))
						.onConflictDoNothing(),
				);
				yield* publishEvents([
					{
						channel: threadChannel(committed.threadId),
						event: streamEvent("thread.changed", { threadId: committed.threadId }),
					},
				]);
			}
			for (const { agentId, reason } of decision.agents) {
				yield* queueTurn({
					threadId: committed.threadId,
					agentId,
					triggerMessageId: committed.id,
					reason,
				});
			}
			return decision;
		}),
	);

/** What `decideFloor` needs from the database, for one thread and message. */
const loadFloorScope = Effect.fn("Floor.loadFloorScope")(function* (
	db: Executor,
	committed: FloorMessage,
): Effect.fn.Return<Omit<FloorInput, "content" | "author">, QueryFailure> {
	const [scope] = yield* db
		.select({
			hostAgentId: thread.hostAgentId,
			podId: thread.podId,
			routing: pod.routing,
			threadType: thread.type,
		})
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.where(eq(thread.id, committed.threadId))
		.limit(1);
	if (!scope) {
		throw new Error("The thread this message is in no longer exists");
	}
	// One query at a time: inside a transaction the executor is a single
	// connection, and queries sent concurrently down one are not run concurrently
	// anyway. The driver queues them, and warns that it is about to stop accepting
	// them at all.
	const crew = yield* db
		.select({ id: agent.id, handle: agent.handle })
		.from(agent)
		.where(and(eq(agent.podId, scope.podId), isNull(agent.systemAgentKey)));
	const participants = yield* db
		.select({ agentId: threadParticipant.agentId })
		.from(threadParticipant)
		.where(eq(threadParticipant.threadId, committed.threadId));
	// Newest first, this message included: how long agents have been talking
	// among themselves, and who among them spoke last.
	const recent = yield* db
		.select({ id: message.id, authorAgentId: message.authorAgentId })
		.from(message)
		.where(and(eq(message.threadId, committed.threadId), eq(message.status, "complete")))
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(MAX_AGENT_RUN + 1);

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
		crew,
		agentParticipantIds: new Set(participants.flatMap((row) => (row.agentId ? [row.agentId] : []))),
		lastAgentSpeakerId: previous?.authorAgentId ?? undefined,
		agentRun,
	};
});

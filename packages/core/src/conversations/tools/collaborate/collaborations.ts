export * as Collaborations from "./collaborations.ts";

import type { CollaborationPart } from "@sugabots/contracts";
import { MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import type { DomainEvents } from "../../../database/events/domain-events.ts";
import type * as schema from "../../../database/schema.ts";
import { agent, collaboration, thread } from "../../../database/schema.ts";
import type { ConversationEvent } from "../../events.ts";
import { toCollaborationPart } from "../../threads/collaboration-parts.ts";
import { crewOf } from "../../threads/participants.ts";
import { ThreadRepository } from "../../threads/repository.ts";
import { lineageOf } from "../../threads/tree.ts";
import { makeRecords, type WaitOutcome } from "./repository.ts";

/**
 * Collaboration: one crew agent asking another for help.
 *
 * The asking agent's turn calls the `collaborate` tool mid-reply. That opens a
 * child thread hosted by the collaborator, whose first message is the brief,
 * and records a collaboration pointing from the reply to that thread. The
 * reply keeps a reference to the collaboration among its parts at the point
 * the call was made, so a reader sees the text before, the child thread, and
 * the text after.
 */
export interface Interface {
	/**
	 * Opens the collaborator's thread with the brief as its first message and
	 * records the collaboration; floor control asks for the collaborator's
	 * turn when it is opened. Fails, writing nothing, when policy refuses.
	 */
	readonly open: (input: {
		/** The asking agent's thread, agent, turn, reply message, and how far into the reply it was. */
		from: {
			threadId: string;
			agentId: string;
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
	 * Hands the collaborator's reply in its thread `threadId` back to the
	 * agent that asked. Floor control gives an agent that stopped waiting a
	 * turn in the parent thread to pick the answer up.
	 *
	 * `true` when this reply answered an outstanding brief, which concludes
	 * that exchange: the answer has gone to the parent and the asking agent
	 * carries on there. `false` when there was nothing outstanding: a later
	 * message in the same thread is an ordinary one and the floor is decided
	 * as usual.
	 */
	readonly answer: (input: { threadId: string; answer: string }) => Effect.Effect<boolean>;
	/**
	 * Fails a collaboration once its collaborator's turn in its thread ends for
	 * good without answering: failed with no retry, cancelled, or given up
	 * on. Otherwise the asking agent, told the answer would follow, waits for
	 * one that never comes.
	 */
	readonly handler: DomainEvents.Handler<ConversationEvent>;
	/**
	 * Fails the collaborations asked for in these threads that are still
	 * waiting or pending, because the routine run they work for ended. One
	 * another transaction holds is skipped: its holder is moving it on.
	 */
	readonly failUnder: (threadIds: readonly string[]) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Collaborations",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Collaborations");
	const threads = yield* ThreadRepository.Service;
	const repository = yield* makeRecords;

	return Service.of({
		open: ({ from, to, brief }) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* () {
						const [parent] = yield* query((db) =>
							db.select().from(thread).where(eq(thread.id, from.threadId)).limit(1),
						);
						if (!parent) {
							return yield* new CollaborationRefused({ reason: "This thread no longer exists" });
						}
						const collaborator = yield* crewNamed(parent, to);
						if (!collaborator) {
							return yield* new CollaborationRefused({
								reason: `No crew agent called "${to}" is in this pod`,
							});
						}
						if (collaborator.id === from.agentId) {
							return yield* new CollaborationRefused({
								reason: "An agent cannot collaborate with itself",
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
								reason: `${collaborator.name} is already waiting on this thread; answer it yourself`,
							});
						}
						if (yield* hasAskedThisTurn(from.turnId, collaborator.id)) {
							return yield* new CollaborationRefused({
								reason: `You have already asked ${collaborator.name} this turn; use what you were told`,
							});
						}

						const child = yield* threads.openCollaborationThread({
							parent,
							askingAgentId: from.agentId,
							collaboratorId: collaborator.id,
							title: firstLine(brief),
							brief,
						});
						const opened = yield* repository.open({
							parentThreadId: parent.id,
							parentMessageId: from.messageId,
							turnId: from.turnId,
							childThreadId: child.threadId,
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

		answer: ({ threadId, answer }) =>
			operation(
				"answer",
				transaction(
					Effect.gen(function* () {
						const answered = yield* repository.answer(threadId, answer);
						return answered !== undefined;
					}),
				),
			),

		handler: (events) =>
			Effect.forEach(events.flatMap(unansweredBy), (ended) => repository.failUnanswered(ended), {
				discard: true,
			}),

		failUnder: repository.failUnder,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ThreadRepository.layer));

/** The collaborator whose turn in a collaboration's thread the event ended without an answer. */
function unansweredBy(
	event: ConversationEvent,
): Array<{ readonly childThreadId: string; readonly collaboratorAgentId: string }> {
	switch (event._tag) {
		case "TurnFailed":
			// A turn that runs again may still answer.
			return event.willRetry
				? []
				: [{ childThreadId: event.threadId, collaboratorAgentId: event.agentId }];
		case "TurnCancelled":
		case "TurnAbandoned":
			return [{ childThreadId: event.threadId, collaboratorAgentId: event.agentId }];
		default:
			return [];
	}
}

/** How deep collaboration may nest: a root thread, a child, and a grandchild. */
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

/** A crew agent placed in the thread's pod, by the name the model used. */
const crewNamed = (parent: schema.ThreadRow, name: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: agent.id, name: agent.name })
				.from(agent)
				.where(
					and(
						crewOf(parent.podId),
						eq(agent.workspaceId, parent.workspaceId),
						sql`lower(${agent.name}) = lower(${name.trim()})`,
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

/** Who hosts each thread above `threadId`, nearest first. */
const hostsAboveOf = (threadId: string) =>
	Effect.map(
		query((db) =>
			db.execute<{ host_agent_id: string }>(
				sql`select lineage.host_agent_id from ${lineageOf(sql`${threadId}`)} as lineage
					where lineage.depth > 0 order by lineage.depth`,
				"objects",
			),
		),
		(rows) => rows.map((row) => row.host_agent_id),
	);

/**
 * Whether the turn already asked this collaborator. A turn may ask several
 * crew agents, but asking one twice only repeats a brief it could have
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
						eq(collaboration.collaboratorAgentId, collaboratorId),
					),
				)
				.limit(1),
		),
		([existing]) => existing !== undefined,
	);

function firstLine(text: string): string {
	const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return line.length <= MAX_THREAD_TITLE_CHARACTERS
		? line
		: `${line.slice(0, MAX_THREAD_TITLE_CHARACTERS - 1).trimEnd()}…`;
}

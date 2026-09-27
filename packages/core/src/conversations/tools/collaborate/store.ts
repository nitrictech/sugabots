import type { CollaborationPart } from "@sugabots/contracts";
import {
	MAX_THREAD_TITLE_CHARACTERS,
	streamEvent,
	threadChannel,
	workspaceChannel,
} from "@sugabots/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../../database/database.ts";
import type { PublishEvents } from "../../../database/events/publish.ts";
import type * as schema from "../../../database/schema.ts";
import {
	agent,
	chat,
	collaboration,
	message,
	thread,
	threadParticipant,
} from "../../../database/schema.ts";
import { toCollaborationPart } from "../../threads/collaborations.ts";
import type { QueueTurn } from "../../turns/queue.ts";

/**
 * Collaboration: one crew agent asking another for help.
 *
 * The asking agent's turn calls the `collaborate` tool mid-reply. That opens a
 * child thread hosted by the collaborator, whose first message is the brief, and
 * records a `collaboration` row pointing from the reply to that thread. The reply
 * keeps a reference to the collaboration among its parts at the point the call was
 * made, so a reader sees the text before, the child thread, and the text after.
 *
 * A collaboration moves through `waiting` (the asking turn is blocked on it),
 * `pending` (it gave up waiting; the answer will resume it), and `answered` or
 * `failed`. Two writers can race for a collaboration, the waiting tool and the
 * collaborator's completing turn, so every transition locks the row and acts on
 * its current status.
 */

/** How deep collaboration may nest: a root thread, a child, and a grandchild. */
const MAX_DEPTH = 2;

export interface OpenCollaboration {
	collaboration: CollaborationPart;
	collaborator: { id: string; name: string };
}

export interface CollaborationStore {
	/**
	 * Opens the collaborator's thread with the brief as its first message, queues
	 * the collaborator's turn, and records the collaboration. Fails, writing nothing,
	 * when policy refuses.
	 */
	open(input: {
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
	}): Effect.Effect<OpenCollaboration, CollaborationRefused, Database>;
	/**
	 * Marks that the asking turn stopped waiting. `false` when the collaboration was
	 * answered in the meantime, in which case the caller should read the answer.
	 */
	stopWaiting(collaborationId: string): Effect.Effect<boolean, never, Database>;
	/** The collaborator's reply, once its turn in the child thread has completed. */
	readAnswer(collaborationId: string): Effect.Effect<string | undefined, never, Database>;
	/**
	 * Called when a turn completes in a thread that was opened by collaboration.
	 * Records the reply as the answer and, if the asking agent had stopped
	 * waiting, queues a turn for it in the parent thread so it continues.
	 */
	/**
	 * Hands the collaborator's reply back to the agent that asked.
	 *
	 * `true` when this reply answered an outstanding brief, which concludes that
	 * exchange: the answer has gone to the parent and the asking agent carries on
	 * there. `false` when there was nothing outstanding — a later message in the
	 * same thread is an ordinary one and the floor is decided as usual.
	 */
	deliverAnswer(input: {
		threadId: string;
		answer: string;
	}): Effect.Effect<boolean, never, Database>;
}

/** Policy said no. The reason goes back to the model as the tool's result. */
export class CollaborationRefused extends Data.TaggedError("CollaborationRefused")<{
	readonly reason: string;
}> {
	override get message() {
		return this.reason;
	}
}

export function collaborationStore(
	publishEvents: PublishEvents,
	queueTurn: QueueTurn,
): CollaborationStore {
	/** Tells the parent thread's listeners how a collaboration now stands. */
	const announce = (row: schema.CollaborationRow, collaboratorName: string) =>
		publishEvents([
			{
				channel: threadChannel(row.parentThreadId),
				event: streamEvent("collaboration.updated", {
					threadId: row.parentThreadId,
					messageId: row.parentMessageId,
					collaboration: toCollaborationPart(row, collaboratorName),
				}),
			},
		]);

	return {
		open: ({ from, to, brief }) =>
			transaction(
				Effect.gen(function* () {
					const parent = yield* query((db) => loadThreadRow(db, from.threadId));
					if (!parent) {
						return yield* new CollaborationRefused({ reason: "This thread no longer exists" });
					}
					const collaborator = yield* query((db) => findCrewByName(db, parent, to));
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
					const ancestors = yield* query((db) => loadAncestors(db, parent));
					if (ancestors.length >= MAX_DEPTH) {
						return yield* new CollaborationRefused({
							reason: `Collaboration may only nest ${MAX_DEPTH} deep; answer this yourself`,
						});
					}
					if (ancestors.some((ancestor) => ancestor.hostAgentId === collaborator.id)) {
						return yield* new CollaborationRefused({
							reason: `${collaborator.name} is already waiting on this thread; answer it yourself`,
						});
					}
					if (yield* query((db) => hasCollaboratedThisTurn(db, from.turnId))) {
						return yield* new CollaborationRefused({
							reason: "Only one collaboration per turn; use what you were told",
						});
					}

					const [child] = yield* query((db) =>
						db
							.insert(thread)
							.values({
								workspaceId: parent.workspaceId,
								podId: parent.podId,
								hostAgentId: collaborator.id,
								chatId: parent.chatId,
								type: "collaboration",
								title: firstLine(brief),
								parentThreadId: parent.id,
								initiatorUserId: parent.initiatorUserId,
							})
							.returning({ id: thread.id }),
					);
					if (!child) {
						return yield* Effect.die(new Error("Thread insert returned no row"));
					}
					yield* query((db) =>
						db.insert(threadParticipant).values([
							{ threadId: child.id, agentId: from.agentId },
							{ threadId: child.id, agentId: collaborator.id },
						]),
					);
					const [briefMessage] = yield* query((db) =>
						db
							.insert(message)
							.values({
								threadId: child.id,
								authorAgentId: from.agentId,
								kind: "text",
								status: "complete",
								parts: [{ type: "text", text: brief }],
								content: brief,
							})
							.returning({ id: message.id }),
					);
					if (!briefMessage) {
						return yield* Effect.die(new Error("Message insert returned no row"));
					}
					yield* queueTurn({
						threadId: child.id,
						agentId: collaborator.id,
						triggerMessageId: briefMessage.id,
						reason: "collaboration",
					});

					const [opened] = yield* query((db) =>
						db
							.insert(collaboration)
							.values({
								parentThreadId: parent.id,
								parentMessageId: from.messageId,
								turnId: from.turnId,
								childThreadId: child.id,
								collaboratorAgentId: collaborator.id,
								brief,
								atOffset: from.atOffset,
							})
							.returning(),
					);
					if (!opened) {
						return yield* Effect.die(new Error("Collaboration insert returned no row"));
					}
					const recipientChat = yield* query((db) =>
						findAgentChat(db, parent.podId, collaborator.id),
					);
					yield* announce(opened, collaborator.name);
					yield* publishEvents([
						{ channel: workspaceChannel(parent.workspaceId), event: streamEvent("thread.changed") },
						...(recipientChat
							? [
									{
										channel: workspaceChannel(parent.workspaceId),
										event: streamEvent("chat.thread_changed", {
											chatId: recipientChat.id,
											threadId: child.id,
											threadType: "collaboration",
										}),
									},
								]
							: []),
					]);
					return {
						collaboration: toCollaborationPart(opened, collaborator.name),
						collaborator,
					};
				}),
			),

		stopWaiting: (collaborationId) =>
			transaction(
				Effect.gen(function* () {
					const current = yield* query((db) =>
						lockCollaboration(db, eq(collaboration.id, collaborationId)),
					);
					if (current?.row.status !== "waiting") {
						return false;
					}
					const updated = yield* query((db) =>
						writeStatus(db, current.row.id, { status: "pending" }),
					);
					yield* announce(updated, current.collaboratorName);
					return true;
				}),
			),

		readAnswer: (collaborationId) =>
			query((db) =>
				Effect.gen(function* () {
					const [row] = yield* db
						.select({ answer: collaboration.answer })
						.from(collaboration)
						.where(eq(collaboration.id, collaborationId))
						.limit(1);
					return row?.answer ?? undefined;
				}),
			),

		deliverAnswer: ({ threadId, answer }) =>
			transaction(
				Effect.gen(function* () {
					const current = yield* query((db) =>
						lockCollaboration(db, eq(collaboration.childThreadId, threadId)),
					);
					if (!current || current.row.status === "answered" || current.row.status === "failed") {
						return false;
					}
					const updated = yield* query((db) =>
						writeStatus(db, current.row.id, { status: "answered", answer }),
					);
					yield* announce(updated, current.collaboratorName);
					// The asking agent moved on; give it a turn to pick the answer up.
					// While it was still waiting, the tool reads the answer itself.
					if (current.row.status === "pending") {
						yield* queueTurn({
							threadId: current.row.parentThreadId,
							agentId: current.askingAgentId,
							triggerMessageId: current.row.parentMessageId,
							reason: "resume",
						});
					}
					return true;
				}),
			),
	};
}

const loadThreadRow = Effect.fn("CollaborationStore.loadThreadRow")(function* (
	db: Executor,
	threadId: string,
) {
	const [row] = yield* db.select().from(thread).where(eq(thread.id, threadId)).limit(1);
	return row;
});

const findAgentChat = Effect.fn("CollaborationStore.findAgentChat")(function* (
	db: Executor,
	podId: string,
	hostAgentId: string,
) {
	const [row] = yield* db
		.select({ id: chat.id })
		.from(chat)
		.where(and(eq(chat.podId, podId), eq(chat.hostAgentId, hostAgentId)))
		.limit(1);
	return row;
});

/** A crew agent placed in the thread's pod, by the name the model used. */
const findCrewByName = Effect.fn("CollaborationStore.findCrewByName")(function* (
	db: Executor,
	parent: schema.ThreadRow,
	name: string,
) {
	const [row] = yield* db
		.select({ id: agent.id, name: agent.name })
		.from(agent)
		.where(
			and(
				eq(agent.podId, parent.podId),
				eq(agent.workspaceId, parent.workspaceId),
				isNull(agent.systemAgentKey),
				sql`lower(${agent.name}) = lower(${name.trim()})`,
			),
		)
		.limit(1);
	return row;
});

/** The thread's parent, grandparent and so on, nearest first. */
const loadAncestors = Effect.fn("CollaborationStore.loadAncestors")(function* (
	db: Executor,
	start: schema.ThreadRow,
) {
	const ancestors: schema.ThreadRow[] = [];
	let current: schema.ThreadRow | undefined = start;
	while (current?.parentThreadId && ancestors.length <= MAX_DEPTH) {
		current = yield* loadThreadRow(db, current.parentThreadId);
		if (current) {
			ancestors.push(current);
		}
	}
	return ancestors;
});

const hasCollaboratedThisTurn = Effect.fn("CollaborationStore.hasCollaboratedThisTurn")(function* (
	db: Executor,
	turnId: string,
) {
	const [existing] = yield* db
		.select({ id: collaboration.id })
		.from(collaboration)
		.where(eq(collaboration.turnId, turnId))
		.limit(1);
	return existing !== undefined;
});

/**
 * The collaboration, locked for update so a transition is serialised, with the
 * names the announcement and the resume turn need.
 */
const lockCollaboration = Effect.fn("CollaborationStore.lockCollaboration")(function* (
	db: Executor,
	by: ReturnType<typeof eq>,
) {
	const [row] = yield* db
		.select({ collaboration, collaboratorName: agent.name, askingAgentId: message.authorAgentId })
		.from(collaboration)
		.innerJoin(agent, eq(agent.id, collaboration.collaboratorAgentId))
		.innerJoin(message, eq(message.id, collaboration.parentMessageId))
		.where(by)
		.limit(1)
		.for("update", { of: collaboration });
	if (!row?.askingAgentId) {
		return undefined;
	}
	return {
		row: row.collaboration,
		collaboratorName: row.collaboratorName,
		askingAgentId: row.askingAgentId,
	};
});

const writeStatus = Effect.fn("CollaborationStore.writeStatus")(function* (
	db: Executor,
	collaborationId: string,
	change: Pick<schema.CollaborationRow, "status"> &
		Partial<Pick<schema.CollaborationRow, "answer">>,
) {
	const [updated] = yield* db
		.update(collaboration)
		.set(change)
		.where(eq(collaboration.id, collaborationId))
		.returning();
	if (!updated) {
		throw new Error("Collaboration disappeared during update");
	}
	return updated;
});

function firstLine(text: string): string {
	const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return line.length <= MAX_THREAD_TITLE_CHARACTERS
		? line
		: `${line.slice(0, MAX_THREAD_TITLE_CHARACTERS - 1).trimEnd()}…`;
}

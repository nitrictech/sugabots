export * as ThreadRepository from "./repository.ts";

import type { RoutineTriggerAuthor, SystemAgentKey } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction, writtenRow } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	chat,
	message,
	thread,
	threadParticipant,
	threadRead,
} from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import {
	authorRow,
	type PersonIdentity,
	personAuthor,
	personColumns,
	toMessage,
	toPerson,
} from "./participants.ts";

/**
 * The only writer of `thread`, `thread_participant`, `chat` and `thread_read`,
 * and of the messages posted into threads. A turn's reply is the exception: it is
 * `TurnRepository`'s while the turn writes it.
 *
 * Commands take the ids and facts they write, and return rows. Whether
 * somebody may ask for any of this is decided by the caller.
 */
export interface Interface {
	/**
	 * The chat between the pod and its crew agent `hostAgentId`, with its main
	 * thread, created on first use. The agent is in the main thread, and so is
	 * `initiatorUserId` when a person opened it.
	 */
	readonly openChat: (placement: {
		workspaceId: string;
		podId: string;
		hostAgentId: string;
		initiatorUserId: string | null;
	}) => Effect.Effect<schema.ChatRow>;
	/**
	 * Posts a person's message, making them a participant, and announces it.
	 * Posting a message again with the same `id` returns the one already
	 * posted, unchanged and unannounced; an `id` already used by a different
	 * message fails.
	 */
	readonly post: (input: {
		/** The id the person's client chose, which makes sending it again safe to detect. */
		id: string;
		threadId: string;
		author: PersonIdentity;
		content: string;
	}) => Effect.Effect<Posted | AlreadyPosted, MessageIdConflict>;
	/** Brings agents into the thread, announcing the ones who were not there yet. */
	readonly addAgents: (threadId: string, agentIds: readonly string[]) => Effect.Effect<void>;
	/**
	 * Opens the collaborator's thread under `parent`, with both agents in it
	 * and the brief as its first message, written by the asking agent.
	 */
	readonly openCollaborationThread: (input: {
		parent: Pick<schema.ThreadRow, "id" | "workspaceId" | "podId" | "chatId" | "initiatorUserId">;
		askingAgentId: string;
		collaboratorId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<{ threadId: string; briefMessageId: string }>;
	/** Opens a routine run's thread in the agent's chat, with the agent in it. */
	readonly openRoutineThread: (input: {
		workspaceId: string;
		podId: string;
		agentId: string;
		chatId: string;
		title: string;
	}) => Effect.Effect<schema.ThreadRow>;
	/** Posts what started a routine run into its thread, as the run's first message. */
	readonly postRoutineTrigger: (input: {
		threadId: string;
		trigger: RoutineTriggerAuthor;
		content: string;
	}) => Effect.Effect<schema.MessageRow>;
	/**
	 * Posts a routine run's result into the agent's chat's main thread
	 * `threadId`, as a message from the run's agent, and announces it. A run
	 * has one result: posting a second fails.
	 */
	readonly postRoutineResult: (input: {
		threadId: string;
		run: Pick<schema.RoutineExecutionRow, "id" | "threadId" | "agentId" | "routineName">;
		content: string;
	}) => Effect.Effect<schema.MessageRow>;
	/**
	 * The thread the system agent `systemAgentKey` works in under `served`,
	 * hosted by `systemAgentId`: one per system agent per thread, created on
	 * first use.
	 */
	readonly openSystemAgentThread: (input: {
		served: Pick<schema.ThreadRow, "id" | "workspaceId" | "podId" | "initiatorUserId">;
		systemAgentId: string;
		systemAgentKey: SystemAgentKey;
		title: string;
	}) => Effect.Effect<string>;
	readonly retitle: (threadId: string, title: string) => Effect.Effect<void>;
	/** Retitles the thread the system agent `systemAgentKey` works in under `servedThreadId`. */
	readonly retitleSystemAgentThread: (input: {
		servedThreadId: string;
		systemAgentKey: SystemAgentKey;
		title: string;
	}) => Effect.Effect<void>;
	/**
	 * Records that `userId` has read the thread `threadId` up to its newest
	 * finished message, and tells the thread's watchers when that moved them
	 * on. Never moves past a reply still streaming, which is not yet read, so
	 * it is news once it is done, however much was written after it began.
	 * Never moves anyone back.
	 */
	readonly markRead: (userId: string, threadId: string) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ThreadRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ThreadRepository");
	const { emit } = yield* ConversationEvents.Service;

	return Service.of({
		openChat: (placement) =>
			operation(
				"openChat",
				transaction(
					Effect.gen(function* () {
						yield* query((db) =>
							db.execute(
								sql`select pg_advisory_xact_lock(hashtextextended(${`chat:${placement.podId}:${placement.hostAgentId}`}, 0))`,
							),
						);
						const [existing] = yield* query((db) =>
							db
								.select()
								.from(chat)
								.where(
									and(eq(chat.podId, placement.podId), eq(chat.hostAgentId, placement.hostAgentId)),
								)
								.limit(1),
						);
						if (existing) return existing;
						const main = yield* query((db) =>
							db
								.insert(thread)
								.values({
									workspaceId: placement.workspaceId,
									podId: placement.podId,
									hostAgentId: placement.hostAgentId,
									type: "chat",
									title: "Chat",
									initiatorUserId: placement.initiatorUserId,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("thread")));
						const created = yield* query((db) =>
							db
								.insert(chat)
								.values({ ...placement, mainThreadId: main.id })
								.returning(),
						).pipe(Effect.flatMap(writtenRow("chat")));
						yield* query((db) =>
							db.update(thread).set({ chatId: created.id }).where(eq(thread.id, main.id)),
						);
						yield* query((db) =>
							db
								.insert(threadParticipant)
								.values([
									...(placement.initiatorUserId
										? [{ threadId: main.id, userId: placement.initiatorUserId }]
										: []),
									{ threadId: main.id, agentId: placement.hostAgentId },
								]),
						);
						return created;
					}),
				),
			),

		post: (input) =>
			operation(
				"post",
				transaction(
					Effect.gen(function* () {
						// Two sends of one message wait here for each other, so the second
						// finds the first rather than failing on its primary key.
						yield* query((db) =>
							db.execute(
								sql`select pg_advisory_xact_lock(hashtextextended(${`message:${input.id}`}, 0))`,
							),
						);
						const [existing] = yield* query((db) =>
							db.select().from(message).where(eq(message.id, input.id)).limit(1),
						);
						if (existing) {
							if (
								existing.threadId !== input.threadId ||
								existing.authorUserId !== input.author.id ||
								existing.content !== input.content
							) {
								return yield* new MessageIdConflict();
							}
							return { _tag: "AlreadyPosted", message: existing } as const;
						}
						const created = yield* query((db) =>
							db
								.insert(message)
								.values({
									id: input.id,
									threadId: input.threadId,
									authorUserId: input.author.id,
									kind: "text",
									status: "complete",
									parts: [{ type: "text", text: input.content }],
									content: input.content,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("message")));
						const now = yield* DateTime.nowAsDate;
						const placed = yield* query((db) =>
							db
								.update(thread)
								.set({ updatedAt: now })
								.where(eq(thread.id, input.threadId))
								.returning({ workspaceId: thread.workspaceId, podId: thread.podId }),
						).pipe(Effect.flatMap(writtenRow("thread")));
						yield* query((db) =>
							db
								.insert(threadParticipant)
								.values({ threadId: input.threadId, userId: input.author.id })
								.onConflictDoNothing(),
						);
						const author = personAuthor(input.author);
						yield* emit([
							ConversationEvent.MessagePosted({
								threadId: input.threadId,
								workspaceId: placed.workspaceId,
								podId: placed.podId,
								message: toMessage(created, author),
							}),
						]);
						return { _tag: "Posted", message: created } as const;
					}),
				),
			),

		addAgents: (threadId, agentIds) =>
			operation(
				"addAgents",
				transaction(
					Effect.gen(function* () {
						if (agentIds.length === 0) return;
						const inserted = yield* query((db) =>
							db
								.insert(threadParticipant)
								.values(agentIds.map((agentId) => ({ threadId, agentId })))
								.onConflictDoNothing()
								.returning({ agentId: threadParticipant.agentId }),
						);
						const joined = new Set(inserted.map((row) => row.agentId));
						if (joined.size === 0) return;
						yield* emit([
							ConversationEvent.AgentsJoined({
								threadId,
								agentIds: agentIds.filter((agentId) => joined.has(agentId)),
							}),
						]);
					}),
				),
			),

		openCollaborationThread: (input) =>
			operation(
				"openCollaborationThread",
				transaction(
					Effect.gen(function* () {
						const child = yield* query((db) =>
							db
								.insert(thread)
								.values({
									workspaceId: input.parent.workspaceId,
									podId: input.parent.podId,
									hostAgentId: input.collaboratorId,
									chatId: input.parent.chatId,
									type: "collaboration",
									title: input.title,
									parentThreadId: input.parent.id,
									initiatorUserId: input.parent.initiatorUserId,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("thread")));
						yield* query((db) =>
							db.insert(threadParticipant).values([
								{ threadId: child.id, agentId: input.askingAgentId },
								{ threadId: child.id, agentId: input.collaboratorId },
							]),
						);
						const brief = yield* query((db) =>
							db
								.insert(message)
								.values({
									threadId: child.id,
									authorAgentId: input.askingAgentId,
									kind: "text",
									status: "complete",
									parts: [{ type: "text", text: input.brief }],
									content: input.brief,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("message")));
						return { threadId: child.id, briefMessageId: brief.id };
					}),
				),
			),

		openRoutineThread: (input) =>
			operation(
				"openRoutineThread",
				transaction(
					Effect.gen(function* () {
						const created = yield* query((db) =>
							db
								.insert(thread)
								.values({
									workspaceId: input.workspaceId,
									podId: input.podId,
									hostAgentId: input.agentId,
									chatId: input.chatId,
									type: "routine",
									title: input.title,
									initiatorUserId: null,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("thread")));
						yield* query((db) =>
							db.insert(threadParticipant).values({ threadId: created.id, agentId: input.agentId }),
						);
						return created;
					}),
				),
			),

		postRoutineTrigger: (input) =>
			operation(
				"postRoutineTrigger",
				query((db) =>
					db
						.insert(message)
						.values({
							threadId: input.threadId,
							routineTrigger: input.trigger,
							kind: "text",
							status: "complete",
							parts: [{ type: "text", text: input.content }],
							content: input.content,
						})
						.returning(),
				).pipe(Effect.flatMap(writtenRow("message"))),
			),

		postRoutineResult: ({ threadId, run, content }) =>
			operation(
				"postRoutineResult",
				transaction(
					Effect.gen(function* () {
						const [author] = yield* query((db) =>
							db
								.select({
									id: agent.id,
									name: agent.name,
									handle: agent.handle,
									color: agent.color,
									face: agent.face,
								})
								.from(agent)
								.where(eq(agent.id, run.agentId))
								.limit(1),
						);
						if (!author) return yield* Effect.die(new Error("A routine run's agent is gone"));
						const created = yield* query((db) =>
							db
								.insert(message)
								.values({
									threadId,
									authorAgentId: run.agentId,
									routineExecutionId: run.id,
									kind: "text",
									status: "complete",
									parts: [{ type: "text", text: content }],
									content,
								})
								.returning(),
						).pipe(Effect.flatMap(writtenRow("message")));
						const now = yield* DateTime.nowAsDate;
						const placed = yield* query((db) =>
							db
								.update(thread)
								.set({ updatedAt: now })
								.where(eq(thread.id, threadId))
								.returning({ workspaceId: thread.workspaceId, podId: thread.podId }),
						).pipe(Effect.flatMap(writtenRow("thread")));
						yield* emit([
							ConversationEvent.MessagePosted({
								threadId,
								workspaceId: placed.workspaceId,
								podId: placed.podId,
								message: {
									...toMessage(created, authorRow(null, author)),
									routineResultOf: {
										executionId: run.id,
										threadId: run.threadId,
										routineName: run.routineName,
									},
								},
							}),
						]);
						return created;
					}),
				),
			),

		openSystemAgentThread: (input) =>
			operation(
				"openSystemAgentThread",
				Effect.gen(function* () {
					const [created] = yield* query((db) =>
						db
							.insert(thread)
							.values({
								workspaceId: input.served.workspaceId,
								// It stays in the pod whose conversation it serves, even though
								// the system agent hosting it belongs to the workspace.
								podId: input.served.podId,
								hostAgentId: input.systemAgentId,
								chatId: null,
								type: "system_agent",
								title: input.title,
								systemAgentKey: input.systemAgentKey,
								parentThreadId: input.served.id,
								initiatorUserId: input.served.initiatorUserId,
							})
							.onConflictDoNothing({ target: [thread.parentThreadId, thread.systemAgentKey] })
							.returning({ id: thread.id }),
					);
					if (created) return created.id;
					const [existing] = yield* query((db) =>
						db
							.select({ id: thread.id })
							.from(thread)
							.where(
								and(
									eq(thread.parentThreadId, input.served.id),
									eq(thread.systemAgentKey, input.systemAgentKey),
								),
							)
							.limit(1),
					);
					if (!existing) {
						return yield* Effect.die(new Error("Opening a system agent's thread returned none"));
					}
					return existing.id;
				}),
			),

		retitle: (threadId, title) =>
			operation(
				"retitle",
				Effect.flatMap(DateTime.nowAsDate, (now) =>
					query((db) =>
						db.update(thread).set({ title, updatedAt: now }).where(eq(thread.id, threadId)),
					),
				).pipe(Effect.asVoid),
			),

		retitleSystemAgentThread: (input) =>
			operation(
				"retitleSystemAgentThread",
				Effect.flatMap(DateTime.nowAsDate, (now) =>
					query((db) =>
						db
							.update(thread)
							.set({ title: input.title, updatedAt: now })
							.where(
								and(
									eq(thread.parentThreadId, input.servedThreadId),
									eq(thread.systemAgentKey, input.systemAgentKey),
								),
							),
					),
				).pipe(Effect.asVoid),
			),

		markRead: (userId, threadId) =>
			operation(
				"markRead",
				transaction(
					Effect.gen(function* () {
						// The newest message's own time rather than this server's clock, so
						// a message stamped later is never counted as read. As text, which
						// keeps the microseconds a `Date` would drop.
						const [newest] = yield* query((db) => {
							const streaming = alias(message, "streaming_message");
							const oldestStreaming = db
								// Through `sql`, because `min` of a timestamp column is cast to text for reading.
								.select({ at: sql`min(${streaming.createdAt})` })
								.from(streaming)
								.where(and(eq(streaming.threadId, threadId), eq(streaming.status, "streaming")));
							return db
								.select({ at: sql<string | null>`max(${message.createdAt})::text` })
								.from(message)
								.where(
									and(
										eq(message.threadId, threadId),
										ne(message.status, "streaming"),
										sql`${message.createdAt} < coalesce((${oldestStreaming}), 'infinity')`,
									),
								);
						});
						if (!newest?.at) return;
						const readThrough = sql`${newest.at}::timestamptz`;
						const [moved] = yield* query((db) =>
							db
								.insert(threadRead)
								.values({ userId, threadId, readThrough })
								.onConflictDoUpdate({
									target: [threadRead.userId, threadRead.threadId],
									set: { readThrough },
									setWhere: lt(threadRead.readThrough, readThrough),
								})
								.returning({ readThrough: threadRead.readThrough, readAt: threadRead.updatedAt }),
						);
						if (!moved) return;
						const reader = yield* query((db) =>
							db.query.user.findFirst({ where: { id: userId }, ...personColumns }),
						);
						if (!reader) return;
						yield* emit([
							ConversationEvent.ThreadRead({
								threadId,
								person: toPerson(reader),
								readThrough: moved.readThrough,
								readAt: moved.readAt,
							}),
						]);
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** A message posted now, and announced. */
export interface Posted {
	readonly _tag: "Posted";
	readonly message: schema.MessageRow;
}

/** A message posted before with the same id and content, returned as it was. */
export interface AlreadyPosted {
	readonly _tag: "AlreadyPosted";
	readonly message: schema.MessageRow;
}

export class MessageIdConflict extends Data.TaggedError("MessageIdConflict") implements UserFacing {
	override get message() {
		return "A message id was reused for a different message";
	}
	get userMessage() {
		return userText`That message ID is already used by a different message`;
	}
}

import type {
	Chat,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	Message,
} from "@sugabots/contracts";
import { DEFAULT_CHAT_PAGE_LIMIT, streamEvent, threadChannel } from "@sugabots/contracts";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../database/database.ts";
import type { PublishEvents } from "../../database/events/publish.ts";
import { isUuid } from "../../database/ids.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	chat,
	collaboration,
	message,
	pod,
	routineExecution,
	thread,
	threadParticipant,
	turn,
	user,
} from "../../database/schema.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { hasPendingResponseJob } from "../jobs/queue.ts";
import {
	loadParticipants,
	participantColumns,
	personAuthor,
	toMessage,
	toParticipant,
} from "../threads/participants.ts";
import { loadPlacedParts } from "../threads/placed-parts.ts";
import { giveFloor } from "../turns/floor.ts";

export class ChatPlacementRejected extends Data.TaggedError("ChatPlacementRejected") {
	override get message() {
		return "The agent and pod are not available for this chat";
	}
}

export class ChatMessageIdConflict extends Data.TaggedError("ChatMessageIdConflict") {
	override get message() {
		return "That message ID is already used by a different message";
	}
}

/**
 * The chat's agent has no model, so nothing could answer. Refused before the
 * message is saved rather than kept with a turn that will never run.
 */
export class ChatAgentHasNoModel extends Data.TaggedError("ChatAgentHasNoModel") {
	override get message() {
		return "This agent has no model chosen, so it cannot answer yet";
	}
}

export class InvalidChatCursor extends Data.TaggedError("InvalidChatCursor") {
	override get message() {
		return "That chat cursor is invalid";
	}
}

interface ChatScope {
	workspaceId: string;
	podId: string;
	hostAgentId: string;
	userId: string;
}

interface SendMainMessage {
	chatId: string;
	userId: string;
	messageId: string;
	content: string;
}

export interface ChatStore {
	getOrCreate(input: ChatScope): Effect.Effect<Chat, ChatPlacementRejected, Database>;
	messages(
		chatId: string,
		userId: string,
		page?: ChatPageQuery,
	): Effect.Effect<ChatMessagesPage | undefined, InvalidChatCursor, Database>;
	history(
		chatId: string,
		userId: string,
		page?: ChatPageQuery,
	): Effect.Effect<ChatHistoryPage | undefined, InvalidChatCursor, Database>;
	sendMain(
		input: SendMainMessage,
	): Effect.Effect<Message | undefined, ChatMessageIdConflict | ChatAgentHasNoModel, Database>;
}

export function chatStore(publishEvents: PublishEvents): ChatStore {
	return {
		getOrCreate: Effect.fn("ChatStore.getOrCreate")(function* (input) {
			yield* lock(`chat:${input.podId}:${input.hostAgentId}`);
			const visible = yield* query((db) => visibleChatForScope(db, input));
			if (!visible.allowed) return yield* new ChatPlacementRejected();
			if (visible.chat) return toChat(visible.chat);

			const [main] = yield* query((db) =>
				db
					.insert(thread)
					.values({
						workspaceId: input.workspaceId,
						podId: input.podId,
						hostAgentId: input.hostAgentId,
						type: "chat",
						title: "Chat",
						initiatorUserId: input.userId,
					})
					.returning(),
			);
			if (!main) return yield* Effect.die(new Error("Main thread insert returned no row"));
			const [created] = yield* query((db) =>
				db
					.insert(chat)
					.values({ ...input, initiatorUserId: input.userId, mainThreadId: main.id })
					.returning(),
			);
			if (!created) return yield* Effect.die(new Error("Chat insert returned no row"));
			yield* query((db) =>
				db.update(thread).set({ chatId: created.id }).where(eq(thread.id, main.id)),
			);
			yield* query((db) =>
				db.insert(threadParticipant).values([
					{ threadId: main.id, userId: input.userId },
					{ threadId: main.id, agentId: input.hostAgentId },
				]),
			);
			return toChat(created);
		}, transaction),

		messages: Effect.fn("ChatStore.messages")(function* (
			chatId: string,
			userId: string,
			page: ChatPageQuery = { limit: DEFAULT_CHAT_PAGE_LIMIT },
		) {
			yield* Effect.annotateCurrentSpan("chat.id", chatId);
			const visible = yield* query((db) => visibleChat(db, chatId, userId));
			if (!visible) return undefined;
			const before = page.cursor ? yield* decodeCursor(page.cursor) : undefined;
			return yield* query((db) => loadMainMessages(db, visible, page.limit, before));
		}),

		history: Effect.fn("ChatStore.history")(function* (
			chatId: string,
			userId: string,
			page: ChatPageQuery = { limit: DEFAULT_CHAT_PAGE_LIMIT },
		) {
			yield* Effect.annotateCurrentSpan("chat.id", chatId);
			const visible = yield* query((db) => visibleChat(db, chatId, userId));
			if (!visible) return undefined;
			const before = page.cursor ? yield* decodeCursor(page.cursor) : undefined;
			return yield* query((db) => loadHistory(db, visible, page.limit, before));
		}),

		sendMain: (input) =>
			transaction(
				Effect.gen(function* () {
					const visible = yield* query((db) => visibleChat(db, input.chatId, input.userId));
					if (!visible) return undefined;
					yield* lock(`chat-message:${input.messageId}`);
					const existing = yield* query((db) => messageById(db, input.messageId));
					if (existing) {
						if (
							existing.threadId !== visible.mainThreadId ||
							existing.authorUserId !== input.userId ||
							existing.content !== input.content
						) {
							return yield* new ChatMessageIdConflict();
						}
						return yield* query((db) => publicMessage(db, existing));
					}
					const hostModel = yield* query((db) => agentModel(db, visible.hostAgentId));
					if (hostModel === null) return yield* new ChatAgentHasNoModel();

					const [created] = yield* query((db) =>
						db
							.insert(message)
							.values(
								userMessage(input.messageId, visible.mainThreadId, input.userId, input.content),
							)
							.returning(),
					);
					if (!created) return yield* Effect.die(new Error("Chat message insert returned no row"));
					yield* query((db) =>
						db
							.update(thread)
							.set({ updatedAt: new Date() })
							.where(eq(thread.id, visible.mainThreadId)),
					);
					yield* query((db) =>
						db
							.insert(threadParticipant)
							.values({ threadId: visible.mainThreadId, userId: input.userId })
							.onConflictDoNothing(),
					);
					yield* giveFloor(publishEvents, {
						id: created.id,
						threadId: visible.mainThreadId,
						content: created.content,
						author: { kind: "person" },
					});
					const result = yield* query((db) => publicMessage(db, created));
					yield* publishEvents([
						{
							channel: threadChannel(visible.mainThreadId),
							event: streamEvent("message.created", {
								threadId: visible.mainThreadId,
								message: result,
							}),
						},
					]);
					return result;
				}),
			),
	};
}

const lock = (key: string) =>
	query((db) => db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`));

async function visibleChatForScope(db: Executor, input: ChatScope) {
	const [allowed] = await db
		.select({ id: pod.id })
		.from(pod)
		.innerJoin(
			agent,
			and(
				eq(agent.id, input.hostAgentId),
				eq(agent.podId, pod.id),
				eq(agent.workspaceId, pod.workspaceId),
				isNull(agent.systemAgentKey),
			),
		)
		.where(
			and(
				eq(pod.id, input.podId),
				eq(pod.workspaceId, input.workspaceId),
				reachesPod(pod.id, input.userId),
			),
		)
		.limit(1);
	const [existing] = allowed
		? await db
				.select()
				.from(chat)
				.where(and(eq(chat.podId, input.podId), eq(chat.hostAgentId, input.hostAgentId)))
				.limit(1)
		: [];
	return { allowed: allowed !== undefined, chat: existing };
}

async function visibleChat(db: Executor, chatId: string, userId: string) {
	if (!isUuid(chatId)) return undefined;
	const [row] = await db
		.select({ chat })
		.from(chat)
		.where(and(eq(chat.id, chatId), reachesPod(chat.podId, userId)))
		.limit(1);
	return row?.chat;
}

async function agentModel(db: Executor, agentId: string) {
	const [row] = await db
		.select({ model: agent.model })
		.from(agent)
		.where(eq(agent.id, agentId))
		.limit(1);
	return row?.model ?? null;
}

function toChat(row: schema.ChatRow): Chat {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		hostAgentId: row.hostAgentId,
		mainThreadId: row.mainThreadId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function userMessage(id: string, threadId: string, userId: string, content: string) {
	return {
		id,
		threadId,
		authorUserId: userId,
		kind: "text" as const,
		status: "complete" as const,
		parts: [{ type: "text" as const, text: content }],
		content,
	};
}

async function messageById(db: Executor, id: string) {
	const [row] = await db.select().from(message).where(eq(message.id, id)).limit(1);
	return row;
}

async function publicMessage(db: Executor, row: schema.MessageRow): Promise<Message> {
	const [author] = await db
		.select({ userId: user.id, userName: user.name, userImage: user.image })
		.from(user)
		.where(eq(user.id, row.authorUserId ?? ""))
		.limit(1);
	if (!author) throw new Error("Chat message author no longer exists");
	return toMessage(row, personAuthor(author));
}

interface CursorPoint {
	createdAt: Date;
	id: string;
}

async function loadMainMessages(
	db: Executor,
	chatRow: schema.ChatRow,
	limit: number,
	before?: CursorPoint,
): Promise<ChatMessagesPage> {
	const messageRows = await db
		.select({ message, ...participantColumns })
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(
			and(
				eq(message.threadId, chatRow.mainThreadId),
				before ? beforeCondition(message.createdAt, message.id, before) : undefined,
			),
		)
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(limit + 1);
	const collaborationRows = await db
		.select({ collaboration, ...participantColumns })
		.from(collaboration)
		.innerJoin(message, eq(message.id, collaboration.parentMessageId))
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(
			and(
				eq(collaboration.collaboratorAgentId, chatRow.hostAgentId),
				before
					? or(
							lt(collaboration.createdAt, before.createdAt),
							and(eq(collaboration.createdAt, before.createdAt), lt(collaboration.id, before.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(collaboration.createdAt), desc(collaboration.id))
		.limit(limit + 1);
	const routineRows = await db
		.select({
			id: routineExecution.id,
			threadId: routineExecution.threadId,
			routineName: routineExecution.routineName,
			triggerKind: routineExecution.triggerKind,
			acceptedAt: routineExecution.acceptedAt,
		})
		.from(routineExecution)
		.innerJoin(thread, eq(thread.id, routineExecution.threadId))
		.where(
			and(
				eq(thread.chatId, chatRow.id),
				before
					? or(
							lt(routineExecution.acceptedAt, before.createdAt),
							and(
								eq(routineExecution.acceptedAt, before.createdAt),
								lt(routineExecution.id, before.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(routineExecution.acceptedAt), desc(routineExecution.id))
		.limit(limit + 1);
	const messageCandidates = messageRows.map((row) => ({
		kind: "message" as const,
		id: row.message.id,
		createdAt: row.message.createdAt,
		row,
	}));
	const collaborationCandidates = collaborationRows.map((row) => {
		const initiator = toParticipant(row);
		if (initiator.kind !== "agent") {
			throw new Error("Collaboration initiator is not an agent");
		}
		return {
			kind: "collaboration" as const,
			id: row.collaboration.id,
			createdAt: row.collaboration.createdAt,
			item: {
				kind: "collaboration" as const,
				id: row.collaboration.id,
				threadId: row.collaboration.childThreadId,
				initiator,
				createdAt: row.collaboration.createdAt.toISOString(),
			} satisfies ChatMessageItem,
		};
	});
	const routineCandidates = routineRows.map((row) => ({
		kind: "routine" as const,
		id: row.id,
		createdAt: row.acceptedAt,
		item: {
			kind: "routine" as const,
			id: row.id,
			threadId: row.threadId,
			routineName: row.routineName,
			triggerKind: row.triggerKind,
			createdAt: row.acceptedAt.toISOString(),
		} satisfies ChatMessageItem,
	}));
	const candidates = [...messageCandidates, ...collaborationCandidates, ...routineCandidates];
	const page = candidates
		.sort((left, right) =>
			left.createdAt.getTime() === right.createdAt.getTime()
				? right.id.localeCompare(left.id)
				: right.createdAt.getTime() - left.createdAt.getTime(),
		)
		.slice(0, limit);
	const placed = await loadPlacedParts(
		db,
		page.flatMap((candidate) => (candidate.kind === "message" ? [candidate.id] : [])),
	);
	const oldest = page.at(-1);
	return {
		items: page.reverse().map((candidate): ChatMessageItem => {
			if (candidate.kind === "collaboration") return candidate.item;
			if (candidate.kind === "routine") return candidate.item;
			return {
				kind: "message",
				message: toMessage(candidate.row.message, candidate.row, placed(candidate.row.message.id)),
			};
		}),
		nextCursor: candidates.length > limit && oldest ? encodeCursor(oldest) : null,
	};
}

async function loadHistory(
	db: Executor,
	chatRow: schema.ChatRow,
	limit: number,
	before?: CursorPoint,
): Promise<ChatHistoryPage> {
	const rows = await db
		.select()
		.from(thread)
		.where(
			and(
				or(
					eq(thread.chatId, chatRow.id),
					sql`exists (
						select 1 from ${collaboration}
						where ${collaboration.childThreadId} = ${thread.id}
						and ${collaboration.collaboratorAgentId} = ${chatRow.hostAgentId}
					)`,
				),
				inArray(thread.type, ["collaboration", "routine"]),
				before ? beforeCondition(thread.updatedAt, thread.id, before) : undefined,
			),
		)
		.orderBy(desc(thread.updatedAt), desc(thread.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const items: ChatHistoryEntry[] = [];
	for (const row of page) {
		if (row.type !== "collaboration" && row.type !== "routine") continue;
		const [pending] = await db
			.select({ running: hasPendingResponseJob(sql`${thread.id}`) })
			.from(thread)
			.where(eq(thread.id, row.id))
			.limit(1);
		const [latestTurn] = await db
			.select({ status: turn.status })
			.from(turn)
			.where(eq(turn.threadId, row.id))
			.orderBy(desc(turn.startedAt), desc(turn.id))
			.limit(1);
		const [execution] =
			row.type === "routine"
				? await db
						.select({
							id: routineExecution.id,
							routineId: routineExecution.routineId,
							routineName: routineExecution.routineName,
							trigger: routineExecution.trigger,
							state: routineExecution.state,
						})
						.from(routineExecution)
						.where(eq(routineExecution.threadId, row.id))
						.limit(1)
				: [];
		items.push({
			threadId: row.id,
			parentThreadId: row.parentThreadId,
			type: row.type,
			title: row.title,
			participants: await loadParticipants(db, row.id),
			status: execution
				? execution.state
				: (pending?.running ?? false)
					? "running"
					: latestTurn?.status === "failed"
						? "failed"
						: "completed",
			routineExecution: execution
				? {
						executionId: execution.id,
						routineId: execution.routineId,
						routineName: execution.routineName,
						triggerKind: execution.trigger.kind,
						triggeredAt:
							execution.trigger.kind === "cron"
								? execution.trigger.scheduledAt
								: execution.trigger.kind === "webhook"
									? execution.trigger.receivedAt
									: execution.trigger.requestedAt,
					}
				: null,
			latestActivityAt: row.updatedAt.toISOString(),
		});
	}
	const oldest = page.at(-1);
	return {
		items,
		nextCursor:
			rows.length > limit && oldest
				? encodeCursor({ id: oldest.id, createdAt: oldest.updatedAt })
				: null,
	};
}

const beforeCondition = (
	date: typeof message.createdAt | typeof thread.updatedAt,
	id: typeof message.id | typeof thread.id,
	point: CursorPoint,
) => or(lt(date, point.createdAt), and(eq(date, point.createdAt), lt(id, point.id)));

function encodeCursor(point: CursorPoint): string {
	return Buffer.from(`${point.createdAt.toISOString()}\n${point.id}`).toString("base64url");
}

function decodeCursor(cursor: string): Effect.Effect<CursorPoint, InvalidChatCursor> {
	const decoded = Buffer.from(cursor, "base64url").toString();
	const [timestamp, id, extra] = decoded.split("\n");
	const createdAt = timestamp ? new Date(timestamp) : new Date(Number.NaN);
	return extra === undefined &&
		timestamp &&
		id &&
		isUuid(id) &&
		!Number.isNaN(createdAt.getTime()) &&
		createdAt.toISOString() === timestamp &&
		Buffer.from(decoded).toString("base64url") === cursor
		? Effect.succeed({ createdAt, id })
		: Effect.fail(new InvalidChatCursor());
}

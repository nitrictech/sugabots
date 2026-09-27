import type {
	Chat,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatList,
	ChatListItem,
	ChatListScope,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	Message,
} from "@sugabots/contracts";
import { DEFAULT_CHAT_PAGE_LIMIT, streamEvent, threadChannel } from "@sugabots/contracts";
import {
	and,
	asc,
	type DBQueryConfig,
	desc,
	eq,
	inArray,
	isNull,
	ne,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../database/database.ts";
import type { PublishEvents } from "../../database/events/publish.ts";
import { isUuid } from "../../database/ids.ts";
import type { relations } from "../../database/relations.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	chat,
	message,
	pod,
	thread,
	threadParticipant,
	turn,
} from "../../database/schema.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/store.ts";
import {
	agentColumns,
	authorRow,
	messageFromRelations,
	messageRelations,
	personAuthor,
	personColumns,
	toMessage,
	toParticipant,
} from "../threads/participants.ts";
import { giveFloor } from "../turns/floor.ts";
import { type QueueFacilitation, type QueueTurn, respondingIn } from "../turns/queue.ts";

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

interface ChatListRequest {
	workspaceId: string;
	userId: string;
	pod: ChatListScope;
}

interface SendMainMessage {
	chatId: string;
	/** Who is sending, as the caller already knows them. */
	author: { id: string; name: string; image: string | null };
	messageId: string;
	content: string;
}

export interface ChatStore {
	/** The pod's bots with their chats, or undefined when the person cannot reach that pod. */
	list(input: ChatListRequest): Effect.Effect<ChatList | undefined, never, Database>;
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

export function chatStore(
	publishEvents: PublishEvents,
	queueTurn: QueueTurn,
	queueFacilitation: QueueFacilitation,
): ChatStore {
	return {
		list: Effect.fn("ChatStore.list")(function* (input) {
			yield* Effect.annotateCurrentSpan("chat.list.pod", input.pod);
			if (input.pod !== "all") {
				const reachable = yield* query((db) => reachablePod(db, input.pod, input));
				if (!reachable) return undefined;
			}
			const bots = yield* query((db) => listedBots(db, input));
			const threadIds = bots.flatMap((row) => (row.mainThreadId ? [row.mainThreadId] : []));
			const latest = yield* query((db) => latestMessages(db, threadIds));
			const items = bots.flatMap((row): ChatListItem[] => {
				const crew = crewAgentRow(row.agent);
				if (!crew) return [];
				const last = row.mainThreadId ? latest.get(row.mainThreadId) : undefined;
				return [
					{
						agent: toAgent(crew),
						chatId: row.chatId,
						lastMessage: last
							? {
									preview: previewOf(last.content),
									authorUserId: last.authorUserId,
									at: last.createdAt.toISOString(),
								}
							: null,
					},
				];
			});
			return { items: items.sort(byLatestMessage) };
		}),

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
			if (!isUuid(chatId)) return undefined;
			// Before the query, and whether or not the chat is there, so a bad cursor
			// says nothing about the chat.
			const before = page.cursor ? yield* decodeCursor(page.cursor) : undefined;
			const row = yield* query((db) => loadMainPage(db, chatId, userId, page.limit, before));
			return row ? toMainPage(row, page.limit) : undefined;
		}),

		history: Effect.fn("ChatStore.history")(function* (
			chatId: string,
			userId: string,
			page: ChatPageQuery = { limit: DEFAULT_CHAT_PAGE_LIMIT },
		) {
			yield* Effect.annotateCurrentSpan("chat.id", chatId);
			if (!isUuid(chatId)) return undefined;
			const before = page.cursor ? yield* decodeCursor(page.cursor) : undefined;
			const row = yield* query((db) => loadHistory(db, chatId, userId, page.limit, before));
			return row ? toHistoryPage(row, page.limit) : undefined;
		}),

		sendMain: (input) =>
			transaction(
				Effect.gen(function* () {
					const visible = yield* query((db) => visibleChat(db, input.chatId, input.author.id));
					if (!visible) return undefined;
					yield* lock(`chat-message:${input.messageId}`);
					const existing = yield* query((db) => messageById(db, input.messageId));
					if (existing) {
						if (
							existing.threadId !== visible.mainThreadId ||
							existing.authorUserId !== input.author.id ||
							existing.content !== input.content
						) {
							return yield* new ChatMessageIdConflict();
						}
						return toMessage(existing, messageAuthor(input.author));
					}
					const hostModel = yield* query((db) => agentModel(db, visible.hostAgentId));
					if (hostModel === null) return yield* new ChatAgentHasNoModel();

					const [created] = yield* query((db) =>
						db
							.insert(message)
							.values(
								userMessage(input.messageId, visible.mainThreadId, input.author.id, input.content),
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
							.values({ threadId: visible.mainThreadId, userId: input.author.id })
							.onConflictDoNothing(),
					);
					yield* giveFloor(
						{ publishEvents, queueTurn, queueFacilitation },
						{
							id: created.id,
							threadId: visible.mainThreadId,
							content: created.content,
							author: { kind: "person" },
						},
					);
					const result = toMessage(created, messageAuthor(input.author));
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

const reachablePod = Effect.fn("ChatStore.reachablePod")(function* (
	db: Executor,
	podId: string,
	input: ChatListRequest,
) {
	const [row] = yield* db
		.select({ id: pod.id })
		.from(pod)
		.where(
			and(
				eq(pod.id, podId),
				eq(pod.workspaceId, input.workspaceId),
				reachesPod(pod.id, input.userId),
			),
		)
		.limit(1);
	return row !== undefined;
});

/** Every crew bot the list covers, with its chat in its pod when it has one. */
const listedBots = Effect.fn("ChatStore.listedBots")(function* (
	db: Executor,
	input: ChatListRequest,
) {
	const scope = input.pod === "all" ? eq(pod.kind, "shared") : eq(pod.id, input.pod);
	return yield* db
		.select({ agent, chatId: chat.id, mainThreadId: chat.mainThreadId })
		.from(agent)
		.innerJoin(pod, eq(pod.id, agent.podId))
		.leftJoin(chat, and(eq(chat.podId, agent.podId), eq(chat.hostAgentId, agent.id)))
		.where(
			and(
				eq(agent.workspaceId, input.workspaceId),
				isNull(agent.systemAgentKey),
				scope,
				reachesPod(pod.id, input.userId),
			),
		)
		.orderBy(asc(agent.name));
});

/** The newest message with words in it on each thread, in one query. */
const latestMessages = Effect.fn("ChatStore.latestMessages")(function* (
	db: Executor,
	threadIds: readonly string[],
) {
	if (threadIds.length === 0) {
		return new Map<string, { content: string; authorUserId: string | null; createdAt: Date }>();
	}
	const rows = yield* db
		.selectDistinctOn([message.threadId], {
			threadId: message.threadId,
			content: message.content,
			authorUserId: message.authorUserId,
			createdAt: message.createdAt,
		})
		.from(message)
		.where(and(inArray(message.threadId, [...threadIds]), ne(message.content, "")))
		.orderBy(message.threadId, desc(message.createdAt));
	return new Map(rows.map((row) => [row.threadId, row]));
});

const PREVIEW_MAX_LENGTH = 140;

/** A message's first non-empty line, with runs of spaces closed up, cut to fit one row. */
function previewOf(content: string): string {
	const firstLine = content
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.find((line) => line !== "");
	if (!firstLine) return "";
	return firstLine.length > PREVIEW_MAX_LENGTH
		? `${firstLine.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
		: firstLine;
}

function byLatestMessage(left: ChatListItem, right: ChatListItem): number {
	const leftAt = left.lastMessage?.at;
	const rightAt = right.lastMessage?.at;
	if (leftAt && rightAt) return rightAt.localeCompare(leftAt);
	if (leftAt) return -1;
	if (rightAt) return 1;
	return left.agent.name.localeCompare(right.agent.name);
}

const visibleChatForScope = Effect.fn("ChatStore.visibleChatForScope")(function* (
	db: Executor,
	input: ChatScope,
) {
	const [allowed] = yield* db
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
		? yield* db
				.select()
				.from(chat)
				.where(and(eq(chat.podId, input.podId), eq(chat.hostAgentId, input.hostAgentId)))
				.limit(1)
		: [];
	return { allowed: allowed !== undefined, chat: existing };
});

const visibleChat = Effect.fn("ChatStore.visibleChat")(function* (
	db: Executor,
	chatId: string,
	userId: string,
) {
	if (!isUuid(chatId)) return undefined;
	const [row] = yield* db
		.select({ chat })
		.from(chat)
		.where(and(eq(chat.id, chatId), reachesPod(chat.podId, userId)))
		.limit(1);
	return row?.chat;
});

const agentModel = Effect.fn("ChatStore.agentModel")(function* (db: Executor, agentId: string) {
	const [row] = yield* db
		.select({ model: agent.model })
		.from(agent)
		.where(eq(agent.id, agentId))
		.limit(1);
	return row?.model ?? null;
});

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

const messageById = Effect.fn("ChatStore.messageById")(function* (db: Executor, id: string) {
	const [row] = yield* db.select().from(message).where(eq(message.id, id)).limit(1);
	return row;
});

function messageAuthor(author: SendMainMessage["author"]) {
	return personAuthor({ userId: author.id, userName: author.name, userImage: author.image });
}

interface CursorPoint {
	createdAt: Date;
	id: string;
}

/**
 * A page of the chat's main conversation, one statement: its messages with their
 * authors and parts, the collaborations its bot was asked into, and its routine
 * runs, each newest first and one more than the page. Nothing when the caller
 * does not reach the chat's pod.
 */
const loadMainPage = Effect.fn("ChatStore.loadMainPage")(function* (
	db: Executor,
	chatId: string,
	userId: string,
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.chat.findFirst({
		where: { id: chatId, RAW: (row) => reachesPod(row.podId, userId) },
		columns: { id: true },
		with: {
			mainThread: {
				columns: {},
				with: {
					messages: {
						limit: limit + 1,
						orderBy: { createdAt: "desc", id: "desc" },
						...(before && { where: { RAW: (row) => earlierThan(row.createdAt, row.id, before) } }),
						with: messageRelations,
					},
				},
			},
			hostCollaborations: {
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				...(before && { where: { RAW: (row) => earlierThan(row.createdAt, row.id, before) } }),
				columns: { id: true, childThreadId: true, createdAt: true },
				with: {
					parentMessage: {
						columns: {},
						with: { authorUser: personColumns, authorAgent: agentColumns },
					},
				},
			},
			routineExecutions: {
				limit: limit + 1,
				orderBy: { acceptedAt: "desc", id: "desc" },
				...(before && { where: { RAW: (row) => earlierThan(row.acceptedAt, row.id, before) } }),
				columns: {
					id: true,
					threadId: true,
					routineName: true,
					triggerKind: true,
					acceptedAt: true,
				},
			},
		},
	});
});

type MainPage = NonNullable<Effect.Success<ReturnType<typeof loadMainPage>>>;

/** The three sources merged newest first, cut to the page, and put back in reading order. */
function toMainPage(row: MainPage, limit: number) {
	const candidates = [
		...row.mainThread.messages.map((stored) => ({
			id: stored.id,
			createdAt: stored.createdAt,
			item: (): ChatMessageItem => ({ kind: "message", message: messageFromRelations(stored) }),
		})),
		...row.hostCollaborations.map((made) => ({
			id: made.id,
			createdAt: made.createdAt,
			item: (): ChatMessageItem => {
				const initiator = toParticipant(
					authorRow(made.parentMessage.authorUser, made.parentMessage.authorAgent),
				);
				if (initiator.kind !== "agent") {
					throw new Error("Collaboration initiator is not an agent");
				}
				return {
					kind: "collaboration",
					id: made.id,
					threadId: made.childThreadId,
					initiator,
					createdAt: made.createdAt.toISOString(),
				};
			},
		})),
		...row.routineExecutions.map((execution) => ({
			id: execution.id,
			createdAt: execution.acceptedAt,
			item: (): ChatMessageItem => ({
				kind: "routine",
				id: execution.id,
				threadId: execution.threadId,
				routineName: execution.routineName,
				triggerKind: execution.triggerKind,
				createdAt: execution.acceptedAt.toISOString(),
			}),
		})),
	].sort((left, right) =>
		left.createdAt.getTime() === right.createdAt.getTime()
			? right.id.localeCompare(left.id)
			: right.createdAt.getTime() - left.createdAt.getTime(),
	);
	const page = candidates.slice(0, limit);
	const oldest = page.at(-1);
	return {
		items: page.reverse().map((candidate) => candidate.item()),
		nextCursor: candidates.length > limit && oldest ? encodeCursor(oldest) : null,
	};
}

/**
 * A page of the chat's side threads, one statement: its routine runs and
 * collaborations, and those its bot was asked into from elsewhere, each newest
 * activity first and one more than the page. Nothing when the caller does not
 * reach the chat's pod.
 */
const loadHistory = Effect.fn("ChatStore.loadHistory")(function* (
	db: Executor,
	chatId: string,
	userId: string,
	limit: number,
	before: CursorPoint | undefined,
) {
	const sideThreads = {
		limit: limit + 1,
		orderBy: { updatedAt: "desc", id: "desc" },
		where: {
			type: { in: ["collaboration", "routine"] },
			...(before && { RAW: (row) => earlierThan(row.updatedAt, row.id, before) }),
		},
		extras: {
			running: (row) => respondingIn(sql`${row.id}`),
			latestTurnStatus: (row) => sql<schema.TurnRow["status"] | null>`(
				select ${turn.status} from ${turn}
				where ${turn.threadId} = ${row.id}
				order by ${turn.startedAt} desc, ${turn.id} desc
				limit 1
			)`,
		},
		with: {
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { user: personColumns, agent: agentColumns },
			},
			routineExecution: {
				columns: { id: true, routineId: true, routineName: true, trigger: true, state: true },
			},
		},
	} satisfies DBQueryConfig<"many", typeof relations, (typeof relations)["thread"]>;
	return yield* db.query.chat.findFirst({
		where: { id: chatId, RAW: (row) => reachesPod(row.podId, userId) },
		columns: { id: true },
		with: { threads: sideThreads, hostCollaborationThreads: sideThreads },
	});
});

type HistoryRow = NonNullable<Effect.Success<ReturnType<typeof loadHistory>>>;

/** Both lists merged newest activity first, a thread in both counted once, cut to the page. */
function toHistoryPage(row: HistoryRow, limit: number) {
	const threads = [
		...new Map(
			[...row.threads, ...row.hostCollaborationThreads].map((side) => [side.id, side]),
		).values(),
	].sort((left, right) =>
		left.updatedAt.getTime() === right.updatedAt.getTime()
			? right.id.localeCompare(left.id)
			: right.updatedAt.getTime() - left.updatedAt.getTime(),
	);
	const page = threads.slice(0, limit);
	const items = page.flatMap((side): ChatHistoryEntry[] => {
		if (side.type !== "collaboration" && side.type !== "routine") return [];
		// A routine's execution row; a collaboration has none.
		const execution = side.type === "routine" ? side.routineExecution : null;
		return [
			{
				threadId: side.id,
				parentThreadId: side.parentThreadId,
				type: side.type,
				title: side.title,
				participants: side.participants.map(({ user: person, agent: participant }) =>
					toParticipant(authorRow(person, participant)),
				),
				status: execution
					? execution.state
					: side.running
						? "running"
						: side.latestTurnStatus === "failed"
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
				latestActivityAt: side.updatedAt.toISOString(),
			},
		];
	});
	const oldest = page.at(-1);
	return {
		items,
		nextCursor:
			threads.length > limit && oldest
				? encodeCursor({ id: oldest.id, createdAt: oldest.updatedAt })
				: null,
	};
}

/** Rows older than the cursor, by timestamp and then id: the order every page here is read in. */
const earlierThan = (date: SQLWrapper, id: SQLWrapper, point: CursorPoint) =>
	sql<boolean>`(${date}, ${id}) < (${point.createdAt}, ${point.id})`;

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

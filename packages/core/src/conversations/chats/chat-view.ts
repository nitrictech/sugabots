export * as ChatView from "./chat-view.ts";

import type {
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatList,
	ChatListItem,
	ChatListScope,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
} from "@sugabots/contracts";
import { DEFAULT_CHAT_PAGE_LIMIT } from "@sugabots/contracts";
import { and, asc, type DBQueryConfig, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import type { relations } from "../../database/relations.ts";
import type * as schema from "../../database/schema.ts";
import { agent, chat, message, pod, turn } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/agent.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { respondingIn } from "../floor/floor.ts";
import {
	agentColumns,
	authorRow,
	crewOf,
	messageFromRelations,
	messageRelations,
	personColumns,
	toParticipant,
} from "../threads/participants.ts";

/**
 * What the chat screens show, of the chats the current actor can see: the
 * pod's bots with their chats, and a chat's two timelines.
 */
export interface Interface {
	/** The bots with their chats, in the pods of a workspace, by its id or its slug. */
	readonly list: (input: {
		workspace: string;
		pod: ChatListScope;
	}) => Effect.Effect<ChatList, AuthorizationDenied, CurrentActor.Service>;
	/** A page of the chat's main conversation, newest last. */
	readonly messages: (
		chatId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatMessagesPage, ResourceHidden | InvalidChatCursor, CurrentActor.Service>;
	/** A page of the chat's side threads, newest activity first. */
	readonly history: (
		chatId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatHistoryPage, ResourceHidden | InvalidChatCursor, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatView");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("chat.list.pod", input.pod);
					const { workspaceId } = yield* authorization.workspace(input.workspace, "workspace.read");
					const listing = {
						workspaceId,
						pod: input.pod,
						reachesPod: yield* visibility.reachesPod,
					};
					if (input.pod !== "all") {
						const reachable = yield* query((db) => reachablePod(db, input.pod, listing));
						if (!reachable) return yield* new ResourceHidden({ resource: "pod" });
					}
					const bots = yield* query((db) => listedBots(db, listing));
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
			),

		messages: (chatId, page = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			operation(
				"messages",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					if (!isUuid(chatId)) return yield* new ResourceHidden({ resource: "chat" });
					// Before the query, and whether or not the chat is there, so a bad cursor
					// says nothing about the chat.
					const before = page.cursor ? yield* chatCursor(page.cursor) : undefined;
					const reachesPod = yield* visibility.reachesPod;
					const row = yield* query((db) =>
						loadMainPage(db, chatId, reachesPod, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return toMainPage(row, page.limit);
				}),
			),

		history: (chatId, page = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			operation(
				"history",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					if (!isUuid(chatId)) return yield* new ResourceHidden({ resource: "chat" });
					const before = page.cursor ? yield* chatCursor(page.cursor) : undefined;
					const reachesPod = yield* visibility.reachesPod;
					const row = yield* query((db) => loadHistory(db, chatId, reachesPod, page.limit, before));
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return toHistoryPage(row, page.limit);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

export class InvalidChatCursor extends Data.TaggedError("InvalidChatCursor") implements UserFacing {
	get userMessage() {
		return UserMessage.of`That chat cursor is invalid`;
	}
}

/** Which bots a list covers, and `Visibility`'s rule for who is asking. */
interface Listing {
	workspaceId: string;
	pod: ChatListScope;
	reachesPod: Visibility.ReachesPod;
}

const reachablePod = Effect.fn("ChatView.reachablePod")(function* (
	db: Executor,
	podId: string,
	input: Listing,
) {
	const [row] = yield* db
		.select({ id: pod.id })
		.from(pod)
		.where(and(eq(pod.id, podId), eq(pod.workspaceId, input.workspaceId), input.reachesPod(pod.id)))
		.limit(1);
	return row !== undefined;
});

/** Every crew bot the list covers, with its chat in its pod when it has one. */
const listedBots = Effect.fn("ChatView.listedBots")(function* (db: Executor, input: Listing) {
	const scope = input.pod === "all" ? eq(pod.kind, "shared") : eq(pod.id, input.pod);
	return yield* db
		.select({ agent, chatId: chat.id, mainThreadId: chat.mainThreadId })
		.from(agent)
		.innerJoin(pod, crewOf(pod.id))
		.leftJoin(chat, and(eq(chat.podId, agent.podId), eq(chat.hostAgentId, agent.id)))
		.where(and(eq(agent.workspaceId, input.workspaceId), scope, input.reachesPod(pod.id)))
		.orderBy(asc(agent.name));
});

/** The newest message with words in it on each thread, in one query. */
const latestMessages = Effect.fn("ChatView.latestMessages")(function* (
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

/**
 * A page of the chat's main conversation, one statement: its messages with their
 * authors and parts, the collaborations its bot was asked into, and its routine
 * runs, each newest first and one more than the page. Nothing when
 * `reachesPod` does not reach the chat's pod.
 */
const loadMainPage = Effect.fn("ChatView.loadMainPage")(function* (
	db: Executor,
	chatId: string,
	reachesPod: Visibility.ReachesPod,
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.chat.findFirst({
		where: { id: chatId, RAW: (row) => reachesPod(row.podId) },
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
		nextCursor:
			candidates.length > limit && oldest
				? encodeCursor({ at: oldest.createdAt, id: oldest.id })
				: null,
	};
}

/**
 * A page of the chat's side threads, one statement: its routine runs and
 * collaborations, and those its bot was asked into from elsewhere, each newest
 * activity first and one more than the page. Nothing when `reachesPod` does
 * not reach the chat's pod.
 */
const loadHistory = Effect.fn("ChatView.loadHistory")(function* (
	db: Executor,
	chatId: string,
	reachesPod: Visibility.ReachesPod,
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
		where: { id: chatId, RAW: (row) => reachesPod(row.podId) },
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
				? encodeCursor({ at: oldest.updatedAt, id: oldest.id })
				: null,
	};
}

const chatCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidChatCursor());
};

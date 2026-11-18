export * as ChatView from "./chat-view.ts";

import type {
	ActivityFeed,
	ActivityItem,
	AnsweredApproval,
	ApprovalInbox,
	ApprovalRequest,
	BotTaskList,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatList,
	ChatListItem,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	DirectMessageList,
	DirectMessageListItem,
	PersonParticipant,
	PodChatMarkers,
	ToolApprovalDeciders,
} from "@sugabots/contracts";
import {
	DEFAULT_CHAT_PAGE_LIMIT,
	GROUP_MENTION_HANDLES,
	handleFromName,
	mentionPattern,
	messagePreview,
	NOTIFYING_THREAD_TYPES,
	textWithoutNarration,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import {
	and,
	asc,
	type DBQueryConfig,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import {
	type AuthorizationDenied,
	agentStandingsFor,
	mayDecideApprovals,
	ResourceHidden,
	reachedPodStandingsFor,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import type { relations } from "../../database/relations.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	agentSummary,
	CONVERSATION_TYPES,
	collaboration,
	directMember,
	message,
	pinnedAgent,
	pod,
	routine,
	routineExecution,
	type ThreadRow,
	thread,
	threadRead,
	toolCall,
	turn,
	user,
	workspaceMember,
} from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/agent.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { latestRunFailedUnseen, resultPosted, routineExecutionIdOf } from "../routines/routines.ts";
import {
	agentColumns,
	authorRow,
	messageFromRelations,
	messageRelations,
	personColumns,
	recentParticipantsOf,
	toParticipant,
	toPerson,
} from "../threads/participants.ts";
import { membersOfDirectKey } from "../threads/repository.ts";
import { toToolCallPart } from "../threads/tool-calls.ts";
import { decidersOf, SANDBOX_REQUEST_TOOLS } from "../tools/approval-deciders.ts";
import { Turns } from "../turns/turns.ts";
import { toConversationThread, toDirect, toPodChat, toRoutineFeed } from "./conversation.ts";

/**
 * What the chat screens show, of the conversations the current actor can see:
 * a channel's main chat and threads, a bot's tasks, and a conversation's two
 * timelines.
 */
export interface Interface {
	/** The main chat and threads of one channel, `pod` by its id or slug, of a workspace by its id or its slug. */
	readonly list: (input: {
		workspace: string;
		pod: string;
	}) => Effect.Effect<ChatList, AuthorizationDenied, CurrentActor.Service>;
	/** The tasks and automations of the bot `agentId`. Hidden unless the actor reaches it. */
	readonly botTasks: (
		agentId: string,
	) => Effect.Effect<BotTaskList, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How each channel and bot of the workspace the actor reaches stands for
	 * them: its conversations' unread messages, whether any waits on their
	 * decision, and how many of a bot's automations failed.
	 */
	readonly podMarkers: (
		workspace: string,
	) => Effect.Effect<PodChatMarkers, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The actor's direct messages in the workspace, with one other person or a
	 * group, the most recent message first.
	 */
	readonly directMessages: (
		workspace: string,
	) => Effect.Effect<DirectMessageList, AuthorizationDenied, CurrentActor.Service>;
	/** One of the actor's direct messages, as their list shows it. Hidden unless they are in it. */
	readonly directMessage: (
		conversationId: string,
	) => Effect.Effect<DirectMessageListItem, ResourceHidden, CurrentActor.Service>;
	/**
	 * The approvals across the workspace for the actor: those waiting on a
	 * decision they may make, and the latest answered by the bots they reach.
	 */
	readonly approvals: (
		workspace: string,
	) => Effect.Effect<ApprovalInbox, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * What is new for the actor across the workspace's conversations, newest first:
	 * messages that mention them, read or not, and those they have not read;
	 * every automation run, read or not, but those that completed with nothing to
	 * report; and every collaboration, read or not.
	 */
	readonly activity: (
		workspace: string,
	) => Effect.Effect<ActivityFeed, AuthorizationDenied, CurrentActor.Service>;
	/** A page of the conversation, newest last. */
	readonly messages: (
		conversationId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatMessagesPage, ResourceHidden | InvalidPageCursor, CurrentActor.Service>;
	/** A page of the threads opened beside the conversation, newest activity first. */
	readonly history: (
		conversationId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatHistoryPage, ResourceHidden | InvalidPageCursor, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatView");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;

	/** How each of the conversations stands for the actor: its unread messages, and waiting on their decision. */
	const conversationMarks = Effect.fn("ChatView.conversationMarks")(function* (
		workspaceId: string,
		conversationIds: readonly string[],
	) {
		const { userId } = yield* CurrentActor.Service;
		const unread = yield* query((db) => unreadMessageCounts(db, userId, conversationIds));
		const awaiting = yield* query((db) =>
			conversationsAwaitingDecisionBy(db, { workspaceId, userId, conversationIds }),
		);
		return (conversationId: string) => ({
			unreadMessages: unread.get(conversationId) ?? 0,
			needsApproval: awaiting.has(conversationId),
		});
	});

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("conversation.list.pod", input.pod);
					const { workspaceId } = yield* authorization.workspace(input.workspace, "workspace.read");
					const reachesPod = yield* visibility.reachesPod;
					const { userId } = yield* CurrentActor.Service;
					const podId = yield* query((db) =>
						reachablePod(db, input.pod, { workspaceId, reachesPod }),
					);
					if (!podId) return yield* new ResourceHidden({ resource: "pod" });
					const chats = yield* query((db) => podChats(db, podId));
					const chatsUnread = yield* query((db) =>
						unreadMessageCounts(
							db,
							userId,
							chats.map((chat) => chat.id),
						),
					);
					return {
						chats: chats.map((chat) => ({
							conversation: toPodChat(chat),
							unreadMessages: chatsUnread.get(chat.id) ?? 0,
						})),
					};
				}),
			),

		botTasks: (agentId) =>
			operation(
				"botTasks",
				Effect.gen(function* () {
					const { agent: host, actor } = yield* authorization.agent(agentId, "agent.read");
					const { userId } = actor;
					const crewHost = crewAgentRow(host);
					if (!crewHost) return yield* new ResourceHidden({ resource: "agent" });
					const listed = yield* query((db) => tasksOf(db, host.id));
					const threadIds = listed.map((row) => row.conversation.id);
					const latest = yield* query((db) => latestMessages(db, threadIds));
					const waitingOn = yield* query((db) => toolsAwaitingApproval(db, threadIds));
					const marksOf = yield* conversationMarks(host.workspaceId, threadIds);
					const mentioning = yield* query((db) => unreadMentionsIn(db, userId, threadIds));
					const pinned = yield* query((db) => isPinnedBy(db, host.id, userId));
					const shownHost = toAgent(crewHost, { actor, pinned });
					const tasks = listed.map((row): ChatListItem => {
						const last = latest.get(row.conversation.id);
						return {
							agent: shownHost,
							conversation: toConversationThread(row.conversation),
							lastMessage: last
								? {
										preview: replyPreview(last),
										authorUserId: last.authorUserId,
										at: last.createdAt.toISOString(),
									}
								: null,
							participants: row.participants.map(toParticipant),
							waitingOn: waitingOn.get(row.conversation.id) || null,
							...marksOf(row.conversation.id),
							mentionsYou: mentioning.has(row.conversation.id),
						};
					});
					const owned = yield* query((db) => listedRoutines(db, host.id, userId));
					const feedMentions = yield* query((db) =>
						unreadMentionsIn(
							db,
							userId,
							owned.flatMap((row) => (row.feed ? [row.feed.id] : [])),
						),
					);
					const routines = owned.map((row) => ({
						routine: {
							id: row.routine.id,
							name: row.routine.name,
							state: row.routine.state,
							failed: row.failed,
							pausedAfterFailures: row.routine.pausedAfterFailuresAt !== null,
						},
						agent: shownHost,
						conversation: row.feed && toRoutineFeed(row.feed),
						mentionsYou: row.feed !== null && feedMentions.has(row.feed.id),
					}));
					const [summary] = yield* query((db) =>
						db
							.select({ content: agentSummary.content, updatedAt: agentSummary.updatedAt })
							.from(agentSummary)
							.where(eq(agentSummary.agentId, host.id))
							.limit(1),
					);
					return {
						tasks: tasks.sort(byLatestMessage),
						routines,
						summary: summary
							? { content: summary.content, updatedAt: summary.updatedAt.toISOString() }
							: null,
					};
				}),
			),

		podMarkers: (workspace) =>
			operation(
				"podMarkers",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const reachesPod = yield* visibility.reachesPod;
					const reachesAgent = yield* visibility.reachesAgent;
					const chats = yield* query((db) => podChatsReached(db, workspaceId, reachesPod));
					const botThreads = yield* query((db) =>
						botConversationsReached(db, workspaceId, reachesAgent),
					);
					const marksOf = yield* conversationMarks(workspaceId, [
						...chats.map(({ id }) => id),
						...botThreads.map(({ id }) => id),
					]);
					const failed = yield* query((db) =>
						failedRoutinesByAgent(db, workspaceId, reachesAgent, userId),
					);
					const nothing = { unreadMessages: 0, needsApproval: false, failedRoutines: 0 };
					const tally = (into: Record<string, Marker>, key: string, conversationId: string) => {
						const { unreadMessages, needsApproval } = marksOf(conversationId);
						if (unreadMessages === 0 && !needsApproval) return;
						const marked = into[key] ?? nothing;
						into[key] = {
							...marked,
							unreadMessages: marked.unreadMessages + unreadMessages,
							needsApproval: marked.needsApproval || needsApproval,
						};
					};
					const pods: Record<string, Marker> = {};
					for (const chat of chats) tally(pods, chat.podId, chat.id);
					const agents: Record<string, Marker> = {};
					for (const conversation of botThreads)
						tally(agents, conversation.agentId, conversation.id);
					for (const [agentId, failedRoutines] of failed) {
						agents[agentId] = { ...(agents[agentId] ?? nothing), failedRoutines };
					}
					return { pods, agents };
				}),
			),

		directMessages: (workspace) =>
			operation(
				"directMessages",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.read",
					);
					const rows = yield* query((db) => directThreadsOf(db, workspaceId, actor.userId));
					const items = yield* directMessageItems(workspaceId, actor.userId, rows);
					return { items: items.sort(byLatestMessage) };
				}),
			),

		directMessage: (conversationId) =>
			operation(
				"directMessage",
				Effect.gen(function* () {
					const reached = yield* visibility.thread(conversationId);
					if (reached.kind !== "direct") {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
					const { userId } = yield* CurrentActor.Service;
					const [item] = yield* directMessageItems(reached.thread.workspaceId, userId, [
						reached.thread,
					]);
					if (!item) return yield* new ResourceHidden({ resource: "conversation" });
					return item;
				}),
			),

		approvals: (workspace) =>
			operation(
				"approvals",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const deciders = yield* query((db) => approvalDecidersIn(db, workspaceId, userId));
					const reachesThread = yield* visibility.reachesThread;
					const waiting = yield* query((db) =>
						waitingApprovalRows(db, deciders.decidable, reachesThread),
					);
					const answered = yield* query((db) => answeredApprovalRows(db, reachesThread));
					return {
						waiting: waiting.map(toApprovalRequest),
						answered: answered.flatMap((row): AnsweredApproval[] => {
							const answer = answerOf(row);
							return answer ? [{ ...toApprovalRequest(row), answer }] : [];
						}),
					};
				}),
			),

		activity: (workspace) =>
			operation(
				"activity",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const [person] = yield* query((db) =>
						db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1),
					);
					if (!person) return { items: [] };
					const since = DateTime.toDate(
						DateTime.subtract(yield* DateTime.now, { days: ACTIVITY_WINDOW_DAYS }),
					);
					const scope: ActivityScope = {
						workspaceId,
						reachesThread: yield* visibility.reachesThread,
						userId,
						handle: handleFromName(person.name),
						since,
					};
					const messages = yield* query((db) => activityRows(db, scope));
					const runs = yield* query((db) => routineRunRows(db, scope));
					const collaborations = yield* query((db) => collaborationRows(db, scope));
					const items: ActivityItem[] = [
						...messages.map(
							(row): ActivityItem => ({
								kind: row.mentionsYou ? "mention" : "message",
								messageId: row.id,
								author: toParticipant(authorRow(row.authorUser, row.authorAgent)),
								preview: replyPreview(row),
								podId: row.podId,
								conversationId: row.conversationId,
								at: row.createdAt.toISOString(),
								unread: row.unread,
							}),
						),
						...runs.map(
							(row): ActivityItem => ({
								kind: "routine",
								threadId: row.threadId,
								routineName: row.routineName,
								state: row.state,
								triggerKind: row.triggerKind,
								agent: { kind: "agent", ...row.agent },
								preview: row.lastReply && runReportPreview(row.lastReply),
								mentionsYou: row.mentionsYou,
								conversationId: row.conversationId,
								at: row.at.toISOString(),
								unread: row.unread,
							}),
						),
						...collaborations.map(
							(row): ActivityItem => ({
								kind: "collaboration",
								threadId: row.threadId,
								initiator: { kind: "agent", ...row.initiator },
								recipient: { kind: "agent", ...row.recipient },
								status: row.status,
								brief: row.brief,
								conversationId: row.conversationId,
								at: row.at.toISOString(),
								unread: row.unread,
							}),
						),
					];
					return {
						items: items
							.sort((left, right) => right.at.localeCompare(left.at))
							.slice(0, ACTIVITY_ITEMS),
					};
				}),
			),

		messages: (conversationId, page = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			operation(
				"messages",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("conversation.id", conversationId);
					if (!isUuid(conversationId)) {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
					// Before the query, and whether or not the conversation is there, so a
					// bad cursor says nothing about the conversation.
					const before = page.cursor ? yield* pageCursor(page.cursor) : undefined;
					const reachesThread = yield* visibility.reachesThread;
					const row = yield* query((db) =>
						loadMainPage(db, conversationId, reachesThread, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					return toMainPage(row, page.limit);
				}),
			),

		history: (conversationId, page = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			operation(
				"history",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("conversation.id", conversationId);
					if (!isUuid(conversationId)) {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
					const before = page.cursor ? yield* pageCursor(page.cursor) : undefined;
					const reachesThread = yield* visibility.reachesThread;
					const row = yield* query((db) =>
						loadHistory(db, conversationId, reachesThread, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					return toHistoryPage(row, page.limit);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

/** How one channel or bot stands for the person, as the markers show it. */
type Marker = PodChatMarkers["pods"][string];

export class InvalidPageCursor extends Data.TaggedError("InvalidPageCursor") implements UserFacing {
	get userMessage() {
		return userText`That page cursor is invalid`;
	}
}

/** The id of the channel `podRef` names, by its id or its slug, when the actor reaches it. */
const reachablePod = Effect.fn("ChatView.reachablePod")(function* (
	db: Executor,
	podRef: string,
	input: { workspaceId: string; reachesPod: Visibility.ReachesPod },
) {
	const [row] = yield* db
		.select({ id: pod.id })
		.from(pod)
		.where(
			and(
				isUuid(podRef) ? eq(pod.id, podRef) : eq(pod.slug, podRef),
				eq(pod.workspaceId, input.workspaceId),
				input.reachesPod(pod.id),
			),
		)
		.limit(1);
	return row?.id;
});

/** The tasks of the bot `agentId`, most recently changed first, each with who has written in it lately. */
const tasksOf = Effect.fn("ChatView.tasksOf")(function* (db: Executor, agentId: string) {
	const conversation = alias(thread, "conversation");
	return yield* db
		.select({ conversation, participants: recentParticipantsOf(conversation.id) })
		.from(conversation)
		.where(and(eq(conversation.type, "conversation"), eq(conversation.hostAgentId, agentId)))
		.orderBy(desc(conversation.updatedAt), desc(conversation.id));
});

/** Whether `userId` pinned the bot `agentId`. */
const isPinnedBy = Effect.fn("ChatView.isPinnedBy")(function* (
	db: Executor,
	agentId: string,
	userId: string,
) {
	const [row] = yield* db
		.select({ id: pinnedAgent.agentId })
		.from(pinnedAgent)
		.where(and(eq(pinnedAgent.agentId, agentId), eq(pinnedAgent.userId, userId)))
		.limit(1);
	return row !== undefined;
});

/**
 * The automations of the bot `agentId` that are still there, by name, each
 * with its thread when it has one, and whether it failed since `userId` last
 * looked.
 */
const listedRoutines = Effect.fn("ChatView.listedRoutines")(function* (
	db: Executor,
	agentId: string,
	userId: string,
) {
	const feed = alias(thread, "feed");
	return yield* db
		.select({ routine, feed, failed: latestRunFailedUnseen(routine.id, userId) })
		.from(routine)
		.leftJoin(feed, eq(feed.routineId, routine.id))
		.where(and(eq(routine.agentId, agentId), isNull(routine.deletedAt)))
		.orderBy(asc(routine.name), asc(routine.id));
});

/** The channel's conversations not archived: its main chat, then its threads in the order they were started. */
const podChats = Effect.fn("ChatView.podChats")(function* (db: Executor, podId: string) {
	return yield* db
		.select()
		.from(thread)
		.where(and(eq(thread.type, "pod_chat"), eq(thread.podId, podId), isNull(thread.archivedAt)))
		.orderBy(desc(thread.main), asc(thread.createdAt), asc(thread.id));
});

/** The conversations not archived of every channel in the workspace that `reachesPod` reaches. */
const podChatsReached = Effect.fn("ChatView.podChatsReached")(function* (
	db: Executor,
	workspaceId: string,
	reachesPod: Visibility.ReachesPod,
) {
	const rows = yield* db
		.select({ id: thread.id, podId: thread.podId })
		.from(thread)
		.where(
			and(
				eq(thread.type, "pod_chat"),
				isNull(thread.archivedAt),
				eq(thread.workspaceId, workspaceId),
				reachesPod(thread.podId),
			),
		);
	return rows.flatMap(({ id, podId }) => (podId ? [{ id, podId }] : []));
});

/** The tasks and automation threads of every bot in the workspace that `reachesAgent` reaches. */
const botConversationsReached = Effect.fn("ChatView.botConversationsReached")(function* (
	db: Executor,
	workspaceId: string,
	reachesAgent: Visibility.ReachesAgent,
) {
	const rows = yield* db
		.select({ id: thread.id, agentId: thread.hostAgentId })
		.from(thread)
		.where(
			and(
				inArray(thread.type, ["conversation", "routine_feed"]),
				eq(thread.workspaceId, workspaceId),
				reachesAgent(thread.hostAgentId),
			),
		);
	return rows.flatMap(({ id, agentId }) => (agentId ? [{ id, agentId }] : []));
});

/** The newest message with words in it on each thread, in one query. */
const latestMessages = Effect.fn("ChatView.latestMessages")(function* (
	db: Executor,
	threadIds: readonly string[],
) {
	if (threadIds.length === 0) {
		return new Map<
			string,
			{
				content: string;
				parts: schema.StoredMessagePart[];
				authorUserId: string | null;
				createdAt: Date;
			}
		>();
	}
	const rows = yield* db
		.selectDistinctOn([message.threadId], {
			threadId: message.threadId,
			content: message.content,
			parts: message.parts,
			authorUserId: message.authorUserId,
			createdAt: message.createdAt,
		})
		.from(message)
		.where(and(inArray(message.threadId, [...threadIds]), ne(message.content, "")))
		.orderBy(message.threadId, desc(message.createdAt));
	return new Map(rows.map((row) => [row.threadId, row]));
});

/**
 * For each of the threads with calls waiting for approval, the tool the first
 * would run in the newest reply that asked, whether or not it wrote anything.
 */
const toolsAwaitingApproval = Effect.fn("ChatView.toolsAwaitingApproval")(function* (
	db: Executor,
	threadIds: readonly string[],
) {
	if (threadIds.length === 0) return new Map<string, string>();
	const rows = yield* db
		.selectDistinctOn([toolCall.threadId], { threadId: toolCall.threadId, tool: toolCall.tool })
		.from(toolCall)
		.innerJoin(message, eq(message.id, toolCall.messageId))
		.where(and(inArray(toolCall.threadId, [...threadIds]), eq(toolCall.approvalStatus, "pending")))
		.orderBy(toolCall.threadId, desc(message.createdAt), asc(toolCall.atOffset), asc(toolCall.id));
	return new Map(rows.map((row) => [row.threadId, row.tool]));
});

/**
 * How many messages with words in them somebody other than `userId` finished on
 * each of the threads since `userId` caught up with it, by `caughtUpAt`.
 * Threads with none are left out.
 */
const unreadMessageCounts = Effect.fn("ChatView.unreadMessageCounts")(function* (
	db: Executor,
	userId: string,
	threadIds: readonly string[],
) {
	if (threadIds.length === 0) return new Map<string, number>();
	const rows = yield* db
		.select({ threadId: message.threadId, count: sql<number>`count(*)::int` })
		.from(message)
		.where(
			and(
				inArray(message.threadId, [...threadIds]),
				finishedWordsFromOthers(userId),
				unreadBy(db, userId, { threadId: message.threadId, at: message.createdAt }),
			),
		)
		.groupBy(message.threadId);
	return new Map(rows.map((row) => [row.threadId, row.count]));
});

/** Those of the threads with a message `userId` has not read that mentions them. */
const unreadMentionsIn = Effect.fn("ChatView.unreadMentionsIn")(function* (
	db: Executor,
	userId: string,
	threadIds: readonly string[],
) {
	if (threadIds.length === 0) return new Set<string>();
	const [person] = yield* db
		.select({ name: user.name })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!person) return new Set<string>();
	const rows = yield* db
		.selectDistinct({ threadId: message.threadId })
		.from(message)
		.where(
			and(
				inArray(message.threadId, [...threadIds]),
				finishedWordsFromOthers(userId),
				mentions(handleFromName(person.name)),
				unreadBy(db, userId, { threadId: message.threadId, at: message.createdAt }),
			),
		);
	return new Set(rows.map((row) => row.threadId));
});

/** A `message` with words in it, finished, written by somebody other than `userId`. */
function finishedWordsFromOthers(userId: string): SQL | undefined {
	return and(
		ne(message.content, ""),
		ne(message.status, "streaming"),
		sql`${message.authorUserId} is distinct from ${userId}`,
	);
}

/**
 * Whether `userId` has yet to catch up with something that happened in
 * `threadId` at `at`, by `caughtUpAt`.
 */
function unreadBy(
	db: Executor,
	userId: string,
	{ threadId, at }: { threadId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`coalesce(${at} > ${caughtUpAt(db, userId, threadId)}, true)`;
}

/**
 * Whether `userId` has yet to catch up with a routine run or collaboration
 * that began at `at`: neither the conversation it is in, `conversationId`,
 * nor its own thread, `itemThreadId`, read past when it began. Opening the
 * item from Inbox reads its own thread, so it reads that item alone.
 */
function itemUnreadBy(
	db: Executor,
	userId: string,
	{
		conversationId,
		itemThreadId,
		at,
	}: { conversationId: SQLWrapper; itemThreadId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`(${unreadBy(db, userId, { threadId: conversationId, at })} and ${unreadBy(db, userId, { threadId: itemThreadId, at })})`;
}

/**
 * When `userId` last caught up with `threadId`: the later of how far they
 * have read it and the last message they wrote there, or null when neither.
 *
 * A reply is stamped when it began. Reading never moves past a reply still
 * being written, so one the person read around still counts once it is done.
 * Writing does: a reply that began before the person's last message counts
 * as caught up with, even if it finished after, because a message does not
 * keep when it finished.
 */
function caughtUpAt(db: Executor, userId: string, threadId: SQLWrapper): SQL<Date | null> {
	const own = alias(message, "own_message");
	// Through `sql`, because a timestamp column selected bare is cast to text for reading.
	const readThrough = db
		.select({ at: sql`${threadRead.readThrough}` })
		.from(threadRead)
		.where(and(sql`${threadRead.threadId} = ${threadId}`, eq(threadRead.userId, userId)));
	const lastWritten = db
		.select({ at: sql`max(${own.createdAt})` })
		.from(own)
		.where(and(sql`${own.threadId} = ${threadId}`, eq(own.authorUserId, userId)));
	return sql<Date | null>`greatest((${readThrough}), (${lastWritten}))`;
}

/**
 * Whether a `message` mentions `handle`, or is a person's `@here` or
 * `@channel` where `groupsMention` holds. A bot's or a routine's notifies
 * nobody, so it mentions nobody.
 */
function mentions(handle: string, groupsMention: SQL = sql`true`): SQL {
	return sql`(${message.content} ~* ${mentionPattern(handle)} or (${message.authorUserId} is not null and ${groupsMention} and ${message.content} ~* ${mentionPattern(...GROUP_MENTION_HANDLES)}))`;
}

/** How far back the activity feed looks: past this, a conversation is old news, read or not. */
const ACTIVITY_WINDOW_DAYS = 30;
/** The most messages the activity feed lists. */
const ACTIVITY_ITEMS = 50;

/**
 * The messages in the conversations `userId` reaches, since `since`, written
 * by somebody else and either mentioning them or not yet read, newest first,
 * with their authors.
 */
const activityRows = Effect.fn("ChatView.activityRows")(function* (
	db: Executor,
	input: ActivityScope,
) {
	// `@here` and `@channel` are text in a direct message, where everybody is told of every message.
	const mentionsYou = mentions(input.handle, sql`${thread.type} <> 'direct'`);
	const unread = unreadBy(db, input.userId, {
		threadId: message.threadId,
		at: message.createdAt,
	});
	const author = alias(agent, "author_agent");
	return yield* db
		.select({
			id: message.id,
			parts: message.parts,
			content: message.content,
			createdAt: message.createdAt,
			podId: thread.podId,
			conversationId: thread.id,
			authorUser: { id: user.id, name: user.name, email: user.email, image: user.image },
			authorAgent: {
				id: author.id,
				name: author.name,
				handle: author.handle,
				color: author.color,
				face: author.face,
				shape: author.shape,
			},
			mentionsYou: sql<boolean>`${mentionsYou}`,
			unread: sql<boolean>`${unread}`,
		})
		.from(message)
		.innerJoin(
			thread,
			and(
				eq(thread.id, message.threadId),
				// The threads whose messages notify people are the ones Inbox shows.
				inArray(thread.type, [...NOTIFYING_THREAD_TYPES]),
			),
		)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(author, eq(author.id, message.authorAgentId))
		.where(
			and(
				eq(thread.workspaceId, input.workspaceId),
				input.reachesThread(thread),
				gt(message.createdAt, input.since),
				finishedWordsFromOthers(input.userId),
				or(mentionsYou, unread),
			),
		)
		.orderBy(desc(message.createdAt))
		.limit(ACTIVITY_ITEMS);
});

interface ActivityScope {
	workspaceId: string;
	reachesThread: Visibility.ReachesThread;
	userId: string;
	/** The person's handle, which mentions of them use. */
	handle: string;
	since: Date;
}

/** The newest finished reply with words in it a bot wrote in `threadId`, or null when it has written none. */
function lastReplyIn(db: Executor, threadId: SQLWrapper): SQL<Reply | null> {
	const reply = alias(message, "last_reply");
	const latest = db
		.select({ reply: sql`json_build_object('content', ${reply.content}, 'parts', ${reply.parts})` })
		.from(reply)
		.where(
			and(
				sql`${reply.threadId} = ${threadId}`,
				sql`${reply.authorAgentId} is not null`,
				ne(reply.content, ""),
				ne(reply.status, "streaming"),
			),
		)
		.orderBy(desc(reply.createdAt))
		.limit(1);
	return sql<Reply | null>`(${latest})`;
}

/** What a message says, as a preview reads it. */
interface Reply {
	content: string;
	parts: schema.StoredMessagePart[];
}

/** The start of what `reply` says, leaving out the narration before its tool calls. */
function replyPreview(reply: Reply): string {
	return messagePreview(spokenText(reply));
}

/**
 * The start of a routine run's report. A report often opens with a heading,
 * so its lines run together, and the preview reads past the heading.
 */
function runReportPreview(reply: Reply): string {
	return messagePreview(spokenText(reply).replace(/\s+/g, " "));
}

/** What `reply` says as a thread shows it, without the narration before its tool calls. */
function spokenText(reply: Reply): string {
	return textWithoutNarration(reply.parts) || reply.content;
}

/**
 * The bots `reachesAgent` reaches with automations whose latest run failed
 * since `userId` last looked, and how many each has.
 */
const failedRoutinesByAgent = Effect.fn("ChatView.failedRoutinesByAgent")(function* (
	db: Executor,
	workspaceId: string,
	reachesAgent: Visibility.ReachesAgent,
	userId: string,
) {
	const rows = yield* db
		.select({ agentId: routine.agentId, count: sql<number>`count(*)::int` })
		.from(routine)
		.where(
			and(
				eq(routine.workspaceId, workspaceId),
				isNull(routine.deletedAt),
				reachesAgent(routine.agentId),
				latestRunFailedUnseen(routine.id, userId),
			),
		)
		.groupBy(routine.agentId);
	return new Map(rows.map((row) => [row.agentId, row.count] as const));
});

/**
 * The routine runs in the conversations `userId` reaches since `since`, newest
 * first, with their last replies, but not those that completed with nothing to
 * report. A run is unread news only once it posted a result or failed, from
 * when it ended. It mentions the person when its result, posted only in the
 * automation's thread, does.
 */
const routineRunRows = Effect.fn("ChatView.routineRunRows")(function* (
	db: Executor,
	input: ActivityScope,
) {
	const conversation = alias(thread, "conversation");
	const posted = resultPosted(routineExecution.id);
	const elsewhere = alias(message, "result_elsewhere");
	const resultMentioningYou = db
		.select({ id: message.id })
		.from(message)
		.where(
			and(
				eq(message.routineExecutionId, routineExecution.id),
				eq(message.threadId, conversation.id),
				mentions(input.handle),
				sql`not exists (${db
					.select({ id: elsewhere.id })
					.from(elsewhere)
					.where(
						and(
							eq(elsewhere.routineExecutionId, routineExecution.id),
							ne(elsewhere.threadId, conversation.id),
						),
					)})`,
			),
		);
	const isNews = or(eq(routineExecution.state, "failed"), posted);
	return yield* db
		.select({
			threadId: routineExecution.threadId,
			routineName: routineExecution.routineName,
			state: routineExecution.state,
			triggerKind: routineExecution.triggerKind,
			at: routineExecution.acceptedAt,
			agent: {
				id: agent.id,
				name: agent.name,
				handle: agent.handle,
				color: agent.color,
				face: agent.face,
				shape: agent.shape,
			},
			conversationId: conversation.id,
			unread: sql<boolean>`(${isNews} and ${itemUnreadBy(db, input.userId, {
				conversationId: conversation.id,
				itemThreadId: routineExecution.threadId,
				at: sql`coalesce(${routineExecution.finishedAt}, ${routineExecution.acceptedAt})`,
			})})`,
			mentionsYou: sql<boolean>`exists (${resultMentioningYou})`,
			lastReply: lastReplyIn(db, routineExecution.threadId),
		})
		.from(routineExecution)
		.innerJoin(thread, eq(thread.id, routineExecution.threadId))
		.innerJoin(conversation, eq(conversation.id, thread.conversationId))
		.innerJoin(agent, eq(agent.id, routineExecution.agentId))
		.where(
			and(
				eq(conversation.workspaceId, input.workspaceId),
				input.reachesThread(conversation),
				gt(routineExecution.acceptedAt, input.since),
				or(ne(routineExecution.state, "completed"), posted),
			),
		)
		.orderBy(desc(routineExecution.acceptedAt))
		.limit(ACTIVITY_ITEMS);
});

/**
 * The collaborations one bot opened with another in the conversations
 * `userId` reaches since `since`, newest first, with both bots.
 */
const collaborationRows = Effect.fn("ChatView.collaborationRows")(function* (
	db: Executor,
	input: ActivityScope,
) {
	const asked = alias(thread, "asked_thread");
	const askingMessage = alias(message, "asking_message");
	const initiator = alias(agent, "initiator");
	const recipient = alias(agent, "recipient");
	const conversation = alias(thread, "conversation");
	return yield* db
		.select({
			threadId: collaboration.childThreadId,
			status: collaboration.status,
			brief: collaboration.brief,
			at: collaboration.createdAt,
			initiator: {
				id: initiator.id,
				name: initiator.name,
				handle: initiator.handle,
				color: initiator.color,
				face: initiator.face,
				shape: initiator.shape,
			},
			recipient: {
				id: recipient.id,
				name: recipient.name,
				handle: recipient.handle,
				color: recipient.color,
				face: recipient.face,
				shape: recipient.shape,
			},
			conversationId: conversation.id,
			unread: itemUnreadBy(db, input.userId, {
				conversationId: conversation.id,
				itemThreadId: collaboration.childThreadId,
				at: collaboration.createdAt,
			}),
		})
		.from(collaboration)
		.innerJoin(asked, eq(asked.id, collaboration.childThreadId))
		.innerJoin(conversation, eq(conversation.id, asked.conversationId))
		.innerJoin(askingMessage, eq(askingMessage.id, collaboration.parentMessageId))
		.innerJoin(initiator, eq(initiator.id, askingMessage.authorAgentId))
		.innerJoin(recipient, eq(recipient.id, collaboration.collaboratorAgentId))
		.where(
			and(
				eq(conversation.workspaceId, input.workspaceId),
				input.reachesThread(conversation),
				gt(collaboration.createdAt, input.since),
			),
		)
		.orderBy(desc(collaboration.createdAt))
		.limit(ACTIVITY_ITEMS);
});

/** How many answered approvals the inbox lists, newest first. */
const ANSWERED_APPROVALS = 50;
/** At most this many waiting approvals are listed; more than this many waiting is a backlog to clear in its conversations. */
const WAITING_APPROVALS = 100;

/**
 * Which approvals `userId` may decide in the threads they reach, by
 * `mayDecideToolCall`, the rule deciding an approval checks: by their
 * standing in the channel or towards the bot of the conversation a thread
 * belongs to, and, for a request to change a bot's computer, towards that bot.
 */
const approvalDecidersIn = Effect.fn("ChatView.approvalDecidersIn")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const agents = new Map(
		(yield* agentStandingsFor(db, workspaceId, userId)).map((standing) => [
			standing.agent.id,
			standing,
		]),
	);
	const pods = new Map(
		(yield* reachedPodStandingsFor(db, workspaceId, userId)).map((standing) => [
			standing.pod.id,
			standing,
		]),
	);
	/** `conversation` is the one the call's thread belongs to; `askingAgentId` the bot that raised it. */
	const mayDecide = (
		conversation: { podId: string | null; hostAgentId: string | null },
		askingAgentId: string,
		inRoutine: boolean,
		deciders: ToolApprovalDeciders,
	) => {
		if (deciders === "sandbox-managers") {
			return agents.get(askingAgentId)?.may("sandbox.request.decide") ?? false;
		}
		if (conversation.podId !== null) {
			return pods.get(conversation.podId)?.may("approval.decide") ?? false;
		}
		const host =
			conversation.hostAgentId === null ? undefined : agents.get(conversation.hostAgentId);
		return host !== undefined && mayDecideApprovals(host, inRoutine, deciders);
	};
	const agentIds = [...agents.keys()];
	const decidable: Decidable = {
		podsDeciding: [...pods.keys()].filter((podId) => pods.get(podId)?.may("approval.decide")),
		outsideRoutines: agentIds.filter((agentId) =>
			mayDecide({ podId: null, hostAgentId: agentId }, agentId, false, "pod"),
		),
		inRoutines: agentIds.filter((agentId) =>
			mayDecide({ podId: null, hostAgentId: agentId }, agentId, true, "pod"),
		),
		sandboxRequests: agentIds.filter((agentId) =>
			mayDecide({ podId: null, hostAgentId: null }, agentId, false, "sandbox-managers"),
		),
	};
	return { mayDecide, decidable };
});

/**
 * Where a person may decide approvals: the channels whose conversations'
 * approvals they decide, the bots whose conversations' approvals they decide,
 * those raised while an automation runs apart, and the bots whose requests to
 * change their computer they decide (see `decidersOf`).
 */
interface Decidable {
	podsDeciding: readonly string[];
	outsideRoutines: readonly string[];
	inRoutines: readonly string[];
	sandboxRequests: readonly string[];
}

/**
 * The tool calls waiting on a decision `decidable` allows, in threads
 * `reachesThread` reaches, oldest first, each with the bot that asked and its
 * conversation.
 */
const waitingApprovalRows = Effect.fn("ChatView.waitingApprovalRows")(function* (
	db: Executor,
	decidable: Decidable,
	reachesThread: Visibility.ReachesThread,
) {
	const asking = alias(thread, "asking_thread");
	const conversation = alias(thread, "approval_conversation");
	const sandboxRequest = inArray(toolCall.tool, [...SANDBOX_REQUEST_TOOLS]);
	const inRoutine = isNotNull(routineExecutionIdOf(asking.id));
	const conditions: SQL[] = [];
	if (decidable.podsDeciding.length > 0) {
		conditions.push(
			sql`not ${sandboxRequest} and ${inArray(conversation.podId, [...decidable.podsDeciding])}`,
		);
	}
	if (decidable.outsideRoutines.length > 0) {
		conditions.push(
			sql`not ${sandboxRequest} and ${inArray(conversation.hostAgentId, [...decidable.outsideRoutines])} and not ${inRoutine}`,
		);
	}
	if (decidable.inRoutines.length > 0) {
		conditions.push(
			sql`not ${sandboxRequest} and ${inArray(conversation.hostAgentId, [...decidable.inRoutines])} and ${inRoutine}`,
		);
	}
	if (decidable.sandboxRequests.length > 0) {
		conditions.push(
			sql`${sandboxRequest} and ${inArray(turn.agentId, [...decidable.sandboxRequests])}`,
		);
	}
	if (conditions.length === 0) return [];
	return yield* selectApprovals(db, asking, conversation)
		.where(and(eq(toolCall.approvalStatus, "pending"), or(...conditions), reachesThread(asking)))
		.orderBy(asc(toolCall.startedAt))
		.limit(WAITING_APPROVALS);
});

/**
 * The tool calls answered in threads `reachesThread` reaches, newest answer
 * first, each with the bot that asked and its conversation.
 */
const answeredApprovalRows = Effect.fn("ChatView.answeredApprovalRows")(function* (
	db: Executor,
	reachesThread: Visibility.ReachesThread,
) {
	const asking = alias(thread, "asking_thread");
	const conversation = alias(thread, "approval_conversation");
	return yield* selectApprovals(db, asking, conversation)
		.where(
			and(
				inArray(toolCall.approvalStatus, ["allowed", "denied"]),
				isNotNull(toolCall.decidedAt),
				reachesThread(asking),
			),
		)
		.orderBy(desc(toolCall.decidedAt))
		.limit(ANSWERED_APPROVALS);
});

/**
 * Tool calls with the bot that asked, the conversation they are in, and who answered.
 * `asking` is the thread a call was made in, aliased because
 * `routineExecutionIdOf` reads `thread` itself.
 */
function selectApprovals(db: Executor, asking: AskingThread, conversation: ApprovalConversation) {
	const decider = alias(user, "decider");
	return db
		.select({
			call: toolCall,
			// A collaboration's is the channel of the conversation it was opened from.
			podId: conversation.podId,
			conversationId: asking.conversationId,
			agent: {
				id: agent.id,
				name: agent.name,
				handle: agent.handle,
				color: agent.color,
				face: agent.face,
				shape: agent.shape,
			},
			decidedByName: decider.name,
		})
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.threadId))
		.innerJoin(conversation, eq(conversation.id, asking.conversationId))
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(agent, eq(agent.id, turn.agentId))
		.leftJoin(decider, eq(decider.id, toolCall.decidedById))
		.$dynamic();
}

type AskingThread = ReturnType<typeof alias<typeof thread, "asking_thread">>;

/** The conversation the asking thread belongs to. */
type ApprovalConversation = ReturnType<typeof alias<typeof thread, "approval_conversation">>;

type ApprovalRow = Effect.Success<ReturnType<typeof answeredApprovalRows>>[number];

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
	return {
		call: toToolCallPart(row.call, row.decidedByName),
		agent: { kind: "agent", ...row.agent },
		podId: row.podId,
		threadId: row.call.threadId,
		conversationId: row.conversationId,
	};
}

/** How `row`'s call was answered, or null when nobody has answered it. */
function answerOf(row: ApprovalRow): AnsweredApproval["answer"] | null {
	const { approvalStatus, decidedAt } = row.call;
	if (approvalStatus !== "allowed" && approvalStatus !== "denied") return null;
	if (!decidedAt) return null;
	return {
		status: approvalStatus,
		decidedByName: row.decidedByName,
		decidedAt: decidedAt.toISOString(),
	};
}

/**
 * Those of `conversationIds` with a tool call waiting for a decision `userId`
 * may make, by the rule deciding the approval checks.
 */
const conversationsAwaitingDecisionBy = Effect.fn("ChatView.conversationsAwaitingDecisionBy")(
	function* (
		db: Executor,
		{
			workspaceId,
			userId,
			conversationIds,
		}: { workspaceId: string; userId: string; conversationIds: readonly string[] },
	) {
		if (conversationIds.length === 0) return new Set<string>();
		// Aliased, because `routineExecutionIdOf` reads `thread` itself, and an
		// unaliased column would name its row rather than this one.
		const asking = alias(thread, "asking_thread");
		const conversation = alias(thread, "approval_conversation");
		const pending = yield* db
			.selectDistinct({
				conversationId: asking.conversationId,
				podId: conversation.podId,
				hostAgentId: conversation.hostAgentId,
				agentId: turn.agentId,
				routineExecutionId: routineExecutionIdOf(asking.id),
				tool: toolCall.tool,
			})
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.threadId))
			.innerJoin(conversation, eq(conversation.id, asking.conversationId))
			.innerJoin(turn, eq(turn.id, toolCall.turnId))
			.where(
				and(
					inArray(asking.conversationId, [...conversationIds]),
					eq(toolCall.approvalStatus, "pending"),
				),
			);
		if (pending.length === 0) return new Set<string>();
		const { mayDecide } = yield* approvalDecidersIn(db, workspaceId, userId);
		return new Set(
			// The conversations are ones the person reaches, so their standing decides.
			pending.flatMap(
				({ conversationId, podId, hostAgentId, agentId, routineExecutionId, tool }) =>
					conversationId &&
					mayDecide({ podId, hostAgentId }, agentId, routineExecutionId !== null, decidersOf(tool))
						? [conversationId]
						: [],
			),
		);
	},
);

/** The direct messages `userId` is in, in the workspace. */
const directThreadsOf = Effect.fn("ChatView.directThreadsOf")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select({ conversation: thread })
		.from(directMember)
		.innerJoin(thread, eq(thread.id, directMember.threadId))
		.where(
			and(
				eq(directMember.userId, userId),
				eq(thread.workspaceId, workspaceId),
				eq(thread.type, "direct"),
			),
		);
	return rows.map((row) => row.conversation);
});

/**
 * `conversations`, direct messages `userId` is in, as their list shows each:
 * the others in it still in the workspace, by name, how many have left, its
 * newest message and how much of it they have not read.
 */
const directMessageItems = (
	workspaceId: string,
	userId: string,
	conversations: readonly ThreadRow[],
) =>
	Effect.gen(function* () {
		const othersIn = new Map(
			conversations.map((conversation) => [
				conversation.id,
				conversation.directKey === null
					? []
					: membersOfDirectKey(conversation.directKey).filter((id) => id !== userId),
			]),
		);
		const threadIds = conversations.map((conversation) => conversation.id);
		const { latest, unread, present } = yield* Effect.all(
			{
				latest: query((db) => latestMessages(db, threadIds)),
				unread: query((db) => unreadMessageCounts(db, userId, threadIds)),
				present: query((db) =>
					workspaceMembersById(db, workspaceId, [...othersIn.values()].flat()),
				),
			},
			{ concurrency: "unbounded" },
		);
		return conversations.map((conversation): DirectMessageListItem => {
			const others = othersIn.get(conversation.id) ?? [];
			const people = others.flatMap((id) => {
				const person = present.get(id);
				return person ? [person] : [];
			});
			const last = latest.get(conversation.id);
			return {
				conversation: toDirect(conversation),
				people: people.sort((left, right) => left.name.localeCompare(right.name)),
				formerMembers: others.length - people.length,
				lastMessage: last
					? {
							preview: replyPreview(last),
							authorUserId: last.authorUserId,
							at: last.createdAt.toISOString(),
						}
					: null,
				unreadMessages: unread.get(conversation.id) ?? 0,
			};
		});
	});

/** The people of `userIds` still in the workspace, by id, as participants. */
const workspaceMembersById = Effect.fn("ChatView.workspaceMembersById")(function* (
	db: Executor,
	workspaceId: string,
	userIds: readonly string[],
) {
	if (userIds.length === 0) return new Map<string, PersonParticipant>();
	const rows = yield* db
		.select({ id: user.id, name: user.name, email: user.email, image: user.image })
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.where(
			and(
				eq(workspaceMember.workspaceId, workspaceId),
				inArray(workspaceMember.userId, [...new Set(userIds)]),
			),
		);
	return new Map(rows.map((row): [string, PersonParticipant] => [row.id, toPerson(row)]));
});

/** A chat or direct message as a list sorts it: by its newest message, or by when it began. */
interface ListedByLatest {
	readonly lastMessage: { readonly at: string } | null;
	readonly conversation: { readonly createdAt: string };
}

/** Newest message first; one nothing is written in yet by when it began. */
function byLatestMessage(left: ListedByLatest, right: ListedByLatest): number {
	const leftAt = left.lastMessage?.at ?? left.conversation.createdAt;
	const rightAt = right.lastMessage?.at ?? right.conversation.createdAt;
	return rightAt.localeCompare(leftAt);
}

/**
 * A page of the conversation: its messages with their authors and parts, and
 * its automation runs, each newest first and one more than the page. Nothing
 * when `reachesThread` does not reach the conversation.
 */
const loadMainPage = Effect.fn("ChatView.loadMainPage")(function* (
	db: Executor,
	conversationId: string,
	reachesThread: Visibility.ReachesThread,
	limit: number,
	before: CursorPoint | undefined,
) {
	const conversation = yield* db.query.thread.findFirst({
		where: {
			id: conversationId,
			type: { in: [...CONVERSATION_TYPES] },
			RAW: (row) => reachesThread(row),
		},
		columns: { id: true },
		with: {
			messages: {
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				...(before && { where: { RAW: (row) => earlierThan(row.createdAt, row.id, before) } }),
				with: messageRelations,
			},
		},
	});
	if (!conversation) return undefined;
	const routineExecutions = yield* db.query.routineExecution.findMany({
		limit: limit + 1,
		orderBy: { acceptedAt: "desc", id: "desc" },
		where: {
			RAW: (row) =>
				and(
					sql`${row.threadId} in (select ${thread.id} from ${thread} where ${thread.conversationId} = ${conversationId})`,
					before && earlierThan(row.acceptedAt, row.id, before),
				) ?? sql`true`,
		},
		columns: {
			id: true,
			threadId: true,
			routineName: true,
			triggerKind: true,
			acceptedAt: true,
			state: true,
			error: true,
		},
		extras: {
			report: (row) => lastReplyIn(db, row.threadId),
			posted: (row) => resultPosted(sql`${row.id}`),
		},
	});
	const [paused] = yield* db
		.select({ routineId: routine.id, at: routine.pausedAfterFailuresAt })
		.from(routine)
		.innerJoin(thread, eq(thread.routineId, routine.id))
		.where(eq(thread.id, conversationId))
		.limit(1);
	// On the page whose span it falls in: the first, or one before where it happened.
	const pausedAfterFailures =
		paused?.at && (!before || paused.at < before.at)
			? { routineId: paused.routineId, at: paused.at }
			: null;
	return { ...conversation, routineExecutions, pausedAfterFailures };
});

/** The status of the newest turn in `threadId`, or null when it has none. */
function latestTurnStatusIn(threadId: SQLWrapper): SQL<schema.TurnRow["status"] | null> {
	return sql<schema.TurnRow["status"] | null>`(
		select ${turn.status} from ${turn}
		where ${turn.threadId} = ${threadId}
		order by ${turn.startedAt} desc, ${turn.id} desc
		limit 1
	)`;
}

type MainPage = NonNullable<Effect.Success<ReturnType<typeof loadMainPage>>>;

/** The routine `routineId` pausing itself at `at`, as a page lists it, by the routine's id. */
function pausedCandidate(routineId: string, at: Date) {
	return {
		id: routineId,
		createdAt: at,
		item: (): ChatMessageItem => ({
			kind: "routine_paused",
			id: routineId,
			createdAt: at.toISOString(),
		}),
	};
}

/** The sources merged newest first, cut to the page, and put back in reading order. */
function toMainPage(row: MainPage, limit: number) {
	const candidates = [
		...row.messages.map((stored) => ({
			id: stored.id,
			createdAt: stored.createdAt,
			item: (): ChatMessageItem => ({ kind: "message", message: messageFromRelations(stored) }),
		})),
		...(row.pausedAfterFailures
			? [pausedCandidate(row.pausedAfterFailures.routineId, row.pausedAfterFailures.at)]
			: []),
		// A run that posted its result is shown by the post, which opens the run.
		...row.routineExecutions
			.filter((execution) => !execution.posted)
			.map((execution) => ({
				id: execution.id,
				createdAt: execution.acceptedAt,
				item: (): ChatMessageItem => ({
					kind: "routine",
					id: execution.id,
					threadId: execution.threadId,
					routineName: execution.routineName,
					triggerKind: execution.triggerKind,
					state: execution.state,
					error: execution.error,
					// Only what the bot said after its last tool call, as a posted result would be.
					report: execution.report && (textWithoutNarration(execution.report.parts) || null),
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
 * A page of the threads opened beside the conversation, one statement: its
 * routine runs and collaborations, each newest activity first and one more
 * than the page. Nothing when `reachesThread` does not reach the
 * conversation.
 */
const loadHistory = Effect.fn("ChatView.loadHistory")(function* (
	db: Executor,
	conversationId: string,
	reachesThread: Visibility.ReachesThread,
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
			running: (row) => Turns.busyIn(sql`${row.id}`),
			latestTurnStatus: (row) => latestTurnStatusIn(row.id),
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
	return yield* db.query.thread.findFirst({
		where: {
			id: conversationId,
			type: { in: [...CONVERSATION_TYPES] },
			RAW: (row) => reachesThread(row),
		},
		columns: { id: true },
		with: { conversationThreads: sideThreads },
	});
});

type HistoryRow = NonNullable<Effect.Success<ReturnType<typeof loadHistory>>>;

/** The threads, loaded newest activity first, cut to the page. */
function toHistoryPage(row: HistoryRow, limit: number) {
	const threads = row.conversationThreads;
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
									: execution.trigger.kind === "manual"
										? execution.trigger.requestedAt
										: execution.trigger.receivedAt,
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

const pageCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidPageCursor());
};

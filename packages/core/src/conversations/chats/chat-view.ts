export * as ChatView from "./chat-view.ts";

import type {
	ActivityFeed,
	ActivityItem,
	AnsweredApproval,
	ApprovalInbox,
	ApprovalRequest,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatList,
	ChatListItem,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	PodChatMarkers,
	ToolApprovalDeciders,
} from "@sugabots/contracts";
import {
	DEFAULT_CHAT_PAGE_LIMIT,
	handleFromName,
	messagePreview,
	PERSONAL_POD_SLUG,
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
	collaboration,
	message,
	pod,
	routineExecution,
	thread,
	threadRead,
	toolCall,
	turn,
	user,
} from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/agent.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { routineExecutionIdOf } from "../routines/routines.ts";
import {
	agentColumns,
	authorRow,
	messageFromRelations,
	messageRelations,
	personColumns,
	toParticipant,
} from "../threads/participants.ts";
import { toToolCallPart } from "../threads/tool-calls.ts";
import { decidersOf, SANDBOX_REQUEST_TOOLS } from "../tools/approval-deciders.ts";
import { Turns } from "../turns/turns.ts";
import { toConversation } from "./conversation.ts";

/**
 * What the chat screens show, of the conversations the current actor can see:
 * the pod's bots with their conversations, and a conversation's two timelines.
 */
export interface Interface {
	/** The bots with their conversations in one pod, `pod` by its id, of a workspace by its id or its slug. */
	readonly list: (input: {
		workspace: string;
		pod: string;
	}) => Effect.Effect<ChatList, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How each pod of the workspace the actor reaches stands for them, Personal
	 * included: its conversations' unread messages, and whether any waits on their decision.
	 */
	readonly podMarkers: (
		workspace: string,
	) => Effect.Effect<PodChatMarkers, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The approvals across the workspace for the actor: those waiting on a
	 * decision they may make, and the latest answered in the pods they reach.
	 */
	readonly approvals: (
		workspace: string,
	) => Effect.Effect<ApprovalInbox, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * What is new for the actor across the workspace's conversations, newest first:
	 * messages that mention them, read or not, and those they have not read;
	 * and every routine run and collaboration, read or not.
	 */
	readonly activity: (
		workspace: string,
	) => Effect.Effect<ActivityFeed, AuthorizationDenied, CurrentActor.Service>;
	/** A page of the conversation, newest last. */
	readonly messages: (
		conversationId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatMessagesPage, ResourceHidden | InvalidChatCursor, CurrentActor.Service>;
	/** A page of the threads opened beside the conversation, newest activity first. */
	readonly history: (
		conversationId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatHistoryPage, ResourceHidden | InvalidChatCursor, CurrentActor.Service>;
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
						reachablePod(db, input.pod, { workspaceId, reachesPod, userId }),
					);
					if (!podId) return yield* new ResourceHidden({ resource: "pod" });
					const listing: Listing = { workspaceId, scope: { pod: podId }, reachesPod };
					const listed = yield* query((db) => listedConversations(db, listing));
					const threadIds = listed.map((row) => row.conversation.id);
					const latest = yield* query((db) => latestMessages(db, threadIds));
					const waitingOn = yield* query((db) => toolsAwaitingApproval(db, threadIds));
					const marksOf = yield* conversationMarks(workspaceId, threadIds);
					const items = listed.map((row): ChatListItem => {
						const crew = row.agent && crewAgentRow(row.agent);
						const last = latest.get(row.conversation.id);
						return {
							agent: crew ? toAgent(crew) : null,
							conversation: toConversation(row.conversation),
							lastMessage: last
								? {
										preview: replyPreview(last),
										authorUserId: last.authorUserId,
										at: last.createdAt.toISOString(),
									}
								: null,
							waitingOn: waitingOn.get(row.conversation.id) || null,
							...marksOf(row.conversation.id),
						};
					});
					const [podChat] = yield* query((db) => podChats(db, [podId]));
					const podChatUnread = podChat
						? ((yield* query((db) => unreadMessageCounts(db, userId, [podChat.id]))).get(
								podChat.id,
							) ?? 0)
						: 0;
					return {
						podChat: podChat
							? { conversation: toConversation(podChat), unreadMessages: podChatUnread }
							: null,
						items: items.sort(byLatestMessage),
					};
				}),
			),

		podMarkers: (workspace) =>
			operation(
				"podMarkers",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const listing: Listing = {
						workspaceId,
						scope: "everyReachablePod",
						reachesPod: yield* visibility.reachesPod,
					};
					const listed = yield* query((db) => listedConversations(db, listing));
					const chats = yield* query((db) => podChatsReached(db, listing));
					const counted = [
						...listed.map(({ conversation }) => ({
							id: conversation.id,
							podId: conversation.podId,
						})),
						...chats,
					];
					const marksOf = yield* conversationMarks(
						workspaceId,
						counted.map(({ id }) => id),
					);
					const pods: Record<string, { unreadMessages: number; needsApproval: boolean }> = {};
					for (const { id, podId } of counted) {
						const { unreadMessages, needsApproval } = marksOf(id);
						if (unreadMessages === 0 && !needsApproval) continue;
						const marked = pods[podId] ?? { unreadMessages: 0, needsApproval: false };
						pods[podId] = {
							unreadMessages: marked.unreadMessages + unreadMessages,
							needsApproval: marked.needsApproval || needsApproval,
						};
					}
					return { pods };
				}),
			),

		approvals: (workspace) =>
			operation(
				"approvals",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const deciders = yield* query((db) => approvalDecidersIn(db, workspaceId, userId));
					const waiting = yield* query((db) => waitingApprovalRows(db, deciders.decidablePods));
					const answered = yield* query((db) => answeredApprovalRows(db, deciders.podIds));
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
					const reachesPod = yield* visibility.reachesPod;
					const { userId } = yield* CurrentActor.Service;
					const since = DateTime.toDate(
						DateTime.subtract(yield* DateTime.now, { days: ACTIVITY_WINDOW_DAYS }),
					);
					const scope = {
						workspaceId,
						reachesPod,
						userId,
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
								podId: row.podId,
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
								podId: row.podId,
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
					const before = page.cursor ? yield* chatCursor(page.cursor) : undefined;
					const reachesPod = yield* visibility.reachesPod;
					const row = yield* query((db) =>
						loadMainPage(db, conversationId, reachesPod, page.limit, before),
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
					const before = page.cursor ? yield* chatCursor(page.cursor) : undefined;
					const reachesPod = yield* visibility.reachesPod;
					const row = yield* query((db) =>
						loadHistory(db, conversationId, reachesPod, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					return toHistoryPage(row, page.limit);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

export class InvalidChatCursor extends Data.TaggedError("InvalidChatCursor") implements UserFacing {
	get userMessage() {
		return userText`That chat cursor is invalid`;
	}
}

/**
 * Which conversations a list covers, and `Visibility`'s rule for who is
 * asking: one pod's, or those of every pod the actor reaches, Personal
 * included, as the rail counts them.
 */
interface Listing {
	workspaceId: string;
	scope: { pod: string } | "everyReachablePod";
	reachesPod: Visibility.ReachesPod;
}

/**
 * The id of the pod `podRef` names, by its id or its slug, when the actor
 * reaches it. Every Personal pod's slug is the same, so that slug names the
 * actor's own Personal pod, whoever else's they might also reach.
 */
const reachablePod = Effect.fn("ChatView.reachablePod")(function* (
	db: Executor,
	podRef: string,
	input: Pick<Listing, "workspaceId" | "reachesPod"> & { userId: string },
) {
	const [row] = yield* db
		.select({ id: pod.id })
		.from(pod)
		.where(
			and(
				podNamed(podRef, input.userId),
				eq(pod.workspaceId, input.workspaceId),
				input.reachesPod(pod.id),
			),
		)
		.limit(1);
	return row?.id;
});

/** Which pod `podRef` names for `userId`: by its id, the shared Personal slug, or its own slug. */
function podNamed(podRef: string, userId: string): SQL | undefined {
	if (isUuid(podRef)) return eq(pod.id, podRef);
	if (podRef === PERSONAL_POD_SLUG) return and(eq(pod.kind, "personal"), eq(pod.ownerId, userId));
	return eq(pod.slug, podRef);
}

/** Every conversation the list covers, with the bot each is with, if any. */
const listedConversations = Effect.fn("ChatView.listedConversations")(function* (
	db: Executor,
	input: Listing,
) {
	const conversation = alias(thread, "conversation");
	return yield* db
		.select({ conversation, agent })
		.from(conversation)
		.leftJoin(agent, eq(agent.id, conversation.hostAgentId))
		.where(
			and(
				eq(conversation.type, "conversation"),
				eq(conversation.workspaceId, input.workspaceId),
				input.scope === "everyReachablePod" ? undefined : eq(conversation.podId, input.scope.pod),
				input.reachesPod(conversation.podId),
			),
		)
		.orderBy(desc(conversation.updatedAt), desc(conversation.id));
});

/** The chats of the pods `podIds` that have one. */
const podChats = Effect.fn("ChatView.podChats")(function* (
	db: Executor,
	podIds: readonly string[],
) {
	return yield* db
		.select()
		.from(thread)
		.where(and(eq(thread.type, "pod_chat"), inArray(thread.podId, [...podIds])));
});

/** The chats of every pod the listing reaches that has one. */
const podChatsReached = Effect.fn("ChatView.podChatsReached")(function* (
	db: Executor,
	input: Listing,
) {
	return yield* db
		.select({ id: thread.id, podId: thread.podId })
		.from(thread)
		.where(
			and(
				eq(thread.type, "pod_chat"),
				eq(thread.workspaceId, input.workspaceId),
				input.reachesPod(thread.podId),
			),
		);
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
 * Whether a `message` mentions `handle`, as the floor reads a mention: an `@`
 * at the start or after a non-word character, and the handle ending there.
 * Handles are lowercase letters, digits and hyphens, so none needs escaping.
 */
function mentions(handle: string): SQL {
	return sql`${message.content} ~* ${`(^|[^a-z0-9_.])@${handle}([^a-z0-9-]|$)`}`;
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
	const [person] = yield* db
		.select({ name: user.name })
		.from(user)
		.where(eq(user.id, input.userId))
		.limit(1);
	if (!person) return [];
	const mentionsYou = mentions(handleFromName(person.name));
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
			and(eq(thread.id, message.threadId), inArray(thread.type, ["conversation", "pod_chat"])),
		)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(author, eq(author.id, message.authorAgentId))
		.where(
			and(
				eq(thread.workspaceId, input.workspaceId),
				input.reachesPod(thread.podId),
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
	reachesPod: Visibility.ReachesPod;
	userId: string;
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

/** The routine runs in the conversations `userId` reaches since `since`, newest first, with their last replies. */
const routineRunRows = Effect.fn("ChatView.routineRunRows")(function* (
	db: Executor,
	input: ActivityScope,
) {
	const conversation = alias(thread, "conversation");
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
			podId: conversation.podId,
			conversationId: conversation.id,
			unread: unreadBy(db, input.userId, {
				threadId: conversation.id,
				at: routineExecution.acceptedAt,
			}),
			lastReply: lastReplyIn(db, routineExecution.threadId),
		})
		.from(routineExecution)
		.innerJoin(thread, eq(thread.id, routineExecution.threadId))
		.innerJoin(conversation, eq(conversation.id, thread.conversationId))
		.innerJoin(agent, eq(agent.id, routineExecution.agentId))
		.where(
			and(
				eq(conversation.workspaceId, input.workspaceId),
				input.reachesPod(conversation.podId),
				gt(routineExecution.acceptedAt, input.since),
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
			podId: conversation.podId,
			conversationId: conversation.id,
			unread: unreadBy(db, input.userId, {
				threadId: conversation.id,
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
				input.reachesPod(conversation.podId),
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
 * Which approvals `userId` may decide in the pods of the workspace they reach,
 * by `mayDecideApprovals`, the rule deciding an approval checks.
 */
const approvalDecidersIn = Effect.fn("ChatView.approvalDecidersIn")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const standings = new Map(
		(yield* reachedPodStandingsFor(db, workspaceId, userId)).map((standing) => [
			standing.pod.id,
			standing,
		]),
	);
	const mayDecide = (podId: string, inRoutine: boolean, deciders: ToolApprovalDeciders = "pod") => {
		const standing = standings.get(podId);
		return standing !== undefined && mayDecideApprovals(standing, inRoutine, deciders);
	};
	const podIds = [...standings.keys()];
	const decidablePods: DecidablePods = {
		outsideRoutines: podIds.filter((podId) => mayDecide(podId, false)),
		inRoutines: podIds.filter((podId) => mayDecide(podId, true)),
		// Wherever they were raised: see `mayDecideApprovals`.
		sandboxRequests: podIds.filter((podId) => mayDecide(podId, false, "sandbox-managers")),
	};
	return { podIds, mayDecide, decidablePods };
});

/**
 * The pods where a person may decide approvals, those raised while a routine
 * runs apart, and requests to change the pod's sandbox, which its sandbox
 * managers decide (see `decidersOf`).
 */
interface DecidablePods {
	outsideRoutines: readonly string[];
	inRoutines: readonly string[];
	sandboxRequests: readonly string[];
}

/** The tool calls waiting on a decision in `pods`, oldest first, each with the bot that asked and its conversation. */
const waitingApprovalRows = Effect.fn("ChatView.waitingApprovalRows")(function* (
	db: Executor,
	pods: DecidablePods,
) {
	const asking = alias(thread, "asking_thread");
	const sandboxRequest = inArray(toolCall.tool, [...SANDBOX_REQUEST_TOOLS]);
	const decidable: SQL[] = [];
	if (pods.outsideRoutines.length > 0) {
		decidable.push(
			sql`not ${sandboxRequest} and ${inArray(asking.podId, [...pods.outsideRoutines])} and ${isNull(routineExecutionIdOf(asking.id))}`,
		);
	}
	if (pods.inRoutines.length > 0) {
		decidable.push(
			sql`not ${sandboxRequest} and ${inArray(asking.podId, [...pods.inRoutines])} and ${isNotNull(routineExecutionIdOf(asking.id))}`,
		);
	}
	if (pods.sandboxRequests.length > 0) {
		decidable.push(sql`${sandboxRequest} and ${inArray(asking.podId, [...pods.sandboxRequests])}`);
	}
	if (decidable.length === 0) return [];
	return yield* selectApprovals(db, asking)
		.where(and(eq(toolCall.approvalStatus, "pending"), or(...decidable)))
		.orderBy(asc(toolCall.startedAt))
		.limit(WAITING_APPROVALS);
});

/** The tool calls answered in `podIds`, newest answer first, each with the bot that asked and its conversation. */
const answeredApprovalRows = Effect.fn("ChatView.answeredApprovalRows")(function* (
	db: Executor,
	podIds: readonly string[],
) {
	if (podIds.length === 0) return [];
	const asking = alias(thread, "asking_thread");
	return yield* selectApprovals(db, asking)
		.where(
			and(
				inArray(asking.podId, [...podIds]),
				inArray(toolCall.approvalStatus, ["allowed", "denied"]),
				isNotNull(toolCall.decidedAt),
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
function selectApprovals(db: Executor, asking: AskingThread) {
	const decider = alias(user, "decider");
	return db
		.select({
			call: toolCall,
			podId: asking.podId,
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
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(agent, eq(agent.id, turn.agentId))
		.leftJoin(decider, eq(decider.id, toolCall.decidedById))
		.$dynamic();
}

type AskingThread = ReturnType<typeof alias<typeof thread, "asking_thread">>;

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
		const pending = yield* db
			.selectDistinct({
				conversationId: asking.conversationId,
				podId: asking.podId,
				routineExecutionId: routineExecutionIdOf(asking.id),
				tool: toolCall.tool,
			})
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.threadId))
			.where(
				and(
					inArray(asking.conversationId, [...conversationIds]),
					eq(toolCall.approvalStatus, "pending"),
				),
			);
		if (pending.length === 0) return new Set<string>();
		const { mayDecide } = yield* approvalDecidersIn(db, workspaceId, userId);
		return new Set(
			pending.flatMap(({ conversationId, podId, routineExecutionId, tool }) =>
				conversationId && mayDecide(podId, routineExecutionId !== null, decidersOf(tool))
					? [conversationId]
					: [],
			),
		);
	},
);

/** Newest message first; a thread nothing is written in yet by when it began. */
function byLatestMessage(left: ChatListItem, right: ChatListItem): number {
	const leftAt = left.lastMessage?.at ?? left.conversation.createdAt;
	const rightAt = right.lastMessage?.at ?? right.conversation.createdAt;
	return rightAt.localeCompare(leftAt);
}

/**
 * A page of the conversation: its messages with their authors and parts, the
 * threads started from them, and its routine runs, each newest first and one
 * more than the page. Nothing when `reachesPod` does not reach
 * the conversation's pod.
 */
const loadMainPage = Effect.fn("ChatView.loadMainPage")(function* (
	db: Executor,
	conversationId: string,
	reachesPod: Visibility.ReachesPod,
	limit: number,
	before: CursorPoint | undefined,
) {
	const conversation = yield* db.query.thread.findFirst({
		where: {
			id: conversationId,
			type: { in: ["conversation", "pod_chat"] },
			RAW: (row) => reachesPod(row.podId),
		},
		columns: { id: true },
		with: {
			messages: {
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				...(before && { where: { RAW: (row) => earlierThan(row.createdAt, row.id, before) } }),
				with: messageRelations,
			},
			openedThreads: {
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				where: {
					type: "conversation",
					...(before && { RAW: (row) => earlierThan(row.createdAt, row.id, before) }),
				},
				columns: { id: true, title: true, originMessageId: true, createdAt: true },
				extras: {
					replies: (row) => sql<number>`(
						select count(*)::int from ${message} where ${message.threadId} = ${row.id}
					)`,
					lastReplyAt: (row) =>
						sql<Date | null>`(
							select max(${message.createdAt}) from ${message} where ${message.threadId} = ${row.id}
						)`.mapWith(message.createdAt),
				},
				with: { hostAgent: agentColumns },
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
		},
	});
	return { ...conversation, routineExecutions };
});

type MainPage = NonNullable<Effect.Success<ReturnType<typeof loadMainPage>>>;

/** The three sources merged newest first, cut to the page, and put back in reading order. */
function toMainPage(row: MainPage, limit: number) {
	const candidates = [
		...row.messages.map((stored) => ({
			id: stored.id,
			createdAt: stored.createdAt,
			item: (): ChatMessageItem => ({ kind: "message", message: messageFromRelations(stored) }),
		})),
		...row.openedThreads.map((opened) => ({
			id: opened.id,
			createdAt: opened.createdAt,
			item: (): ChatMessageItem => ({
				kind: "thread",
				id: opened.id,
				threadId: opened.id,
				originMessageId: opened.originMessageId,
				title: opened.title,
				agent: opened.hostAgent && { kind: "agent", ...opened.hostAgent },
				replies: opened.replies,
				lastReplyAt: opened.lastReplyAt?.toISOString() ?? null,
				createdAt: opened.createdAt.toISOString(),
			}),
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
 * A page of the threads opened beside the conversation, one statement: its
 * routine runs and collaborations, each newest activity first and one more
 * than the page. Nothing when `reachesPod` does not reach the conversation's
 * pod.
 */
const loadHistory = Effect.fn("ChatView.loadHistory")(function* (
	db: Executor,
	conversationId: string,
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
			running: (row) => Turns.busyIn(sql`${row.id}`),
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
	return yield* db.query.thread.findFirst({
		where: {
			id: conversationId,
			type: { in: ["conversation", "pod_chat"] },
			RAW: (row) => reachesPod(row.podId),
		},
		columns: { id: true },
		with: { conversationThreads: sideThreads },
	});
});

type HistoryRow = NonNullable<Effect.Success<ReturnType<typeof loadHistory>>>;

/** Both lists merged newest activity first, a thread in both counted once, cut to the page. */
function toHistoryPage(row: HistoryRow, limit: number) {
	const threads = [
		...new Map(row.conversationThreads.map((side) => [side.id, side])).values(),
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

const chatCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidChatCursor());
};

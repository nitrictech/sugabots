export * as ChatView from "./chat-view.ts";

import type {
	AnsweredApproval,
	ApprovalInbox,
	ApprovalRequest,
	BotMarker,
	BotTaskList,
	ChannelConversationMarkers,
	ChannelMarker,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatList,
	ChatListItem,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	DirectMessageList,
	DirectMessageListItem,
	InboxFeed,
	InboxItem,
	PersonParticipant,
	ToolApprovalDeciders,
} from "@sugabots/contracts";
import {
	DEFAULT_CHAT_PAGE_LIMIT,
	GROUP_MENTION_HANDLES,
	handleFromName,
	mentionPattern,
	messagePreview,
	NOTIFYING_CONVERSATION_KINDS,
	textWithoutNarration,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import {
	and,
	asc,
	count,
	type DBQueryConfig,
	desc,
	eq,
	getColumns,
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
	botStandingsFor,
	type DecidingStanding,
	mayDecideToolCall,
	ResourceHidden,
	reachedChannelStandingsFor,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import type { relations } from "../../database/relations.ts";
import type * as schema from "../../database/schema.ts";
import {
	automation,
	automationFeed,
	automationRun,
	bot,
	botSummary,
	channel,
	collaboration,
	conversationRead,
	directMessageMember,
	message,
	OPENABLE_CONVERSATION_KINDS,
	type PlacedConversationRow,
	pinnedBot,
	placedConversation,
	task,
	toolCall,
	turn,
	user,
	workspaceMember,
} from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { personFacingBotRow, toBot } from "../../workspaces/bots/bot.ts";
import { latestRunFailedUnseen, resultPosted, runIdOf } from "../automations/execution.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import {
	authorRow,
	botColumns,
	messageFromRelations,
	messageRelations,
	personColumns,
	recentParticipantsOf,
	toParticipant,
	toPerson,
} from "../repository/participants.ts";
import { membersOfDirectKey } from "../repository/repository.ts";
import { toToolCallPart } from "../repository/tool-calls.ts";
import { COMPUTER_REQUEST_TOOLS, decidersOf } from "../tools/approval-deciders.ts";
import { Turns } from "../turns/turns.ts";
import {
	toAutomationFeed,
	toChannelConversation,
	toDirectMessage,
	toTask,
} from "./conversation.ts";

/**
 * What the chat screens show, of the conversations the current actor can see:
 * a channel's main chat and threads, a bot's tasks, and a conversation's two
 * timelines.
 */
export interface Interface {
	/** The main chat and threads of one channel, `channel` by its id or slug, of a workspace by its id or its slug. */
	readonly list: (input: {
		workspace: string;
		channel: string;
	}) => Effect.Effect<ChatList, AuthorizationDenied, CurrentActor.Service>;
	/** The tasks and automations of the bot `botId`. Hidden unless the actor reaches it. */
	readonly botTasks: (
		botId: string,
	) => Effect.Effect<BotTaskList, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How each channel and bot of the workspace the actor reaches stands for
	 * them: its conversations' unread messages, whether any waits on their
	 * decision, and how many of a bot's automations failed.
	 */
	readonly channelMarkers: (
		workspace: string,
	) => Effect.Effect<ChannelConversationMarkers, AuthorizationDenied, CurrentActor.Service>;
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
	readonly inbox: (
		workspace: string,
	) => Effect.Effect<InboxFeed, AuthorizationDenied, CurrentActor.Service>;
	/** The newest `limit` messages in the inbox that mention the actor and they have not read. */
	readonly unreadMentions: (
		workspace: string,
		limit: number,
	) => Effect.Effect<InboxItem[], AuthorizationDenied, CurrentActor.Service>;
	/** A page of the conversation, newest last. */
	readonly messages: (
		conversationId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatMessagesPage, ResourceHidden | InvalidPageCursor, CurrentActor.Service>;
	/** A page of the conversations opened beside the conversation, newest activity first. */
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

	/** What the inbox looks through for the actor in `workspace`; none when they have no account. */
	const inboxScopeOf = (workspace: string) =>
		Effect.gen(function* () {
			const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
			const { userId } = yield* CurrentActor.Service;
			const [person] = yield* query((db) =>
				db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1),
			);
			if (!person) return undefined;
			const since = DateTime.toDate(
				DateTime.subtract(yield* DateTime.now, { days: INBOX_WINDOW_DAYS }),
			);
			return {
				workspaceId,
				reachesConversation: yield* visibility.reachesConversation,
				userId,
				handle: handleFromName(person.name),
				since,
			} satisfies InboxScope;
		});

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("conversation.list.channel", input.channel);
					const { workspaceId } = yield* authorization.workspace(input.workspace, "workspace.read");
					const reachesChannel = yield* visibility.reachesChannel;
					const { userId } = yield* CurrentActor.Service;
					const channelId = yield* query((db) =>
						reachableChannel(db, input.channel, { workspaceId, reachesChannel }),
					);
					if (!channelId) return yield* new ResourceHidden({ resource: "channel" });
					const chats = yield* query((db) => channelConversations(db, channelId));
					const chatsUnread = yield* query((db) =>
						unreadMessageCounts(
							db,
							userId,
							chats.map((chat) => chat.id),
						),
					);
					return {
						chats: chats.map((chat) => ({
							conversation: toChannelConversation(chat),
							unreadMessages: chatsUnread.get(chat.id) ?? 0,
						})),
					};
				}),
			),

		botTasks: (botId) =>
			operation(
				"botTasks",
				Effect.gen(function* () {
					const { bot: host, actor } = yield* authorization.bot(botId, "bot.read");
					const { userId } = actor;
					const personFacingHost = personFacingBotRow(host);
					if (!personFacingHost) return yield* new ResourceHidden({ resource: "bot" });
					const listed = yield* query((db) => tasksOf(db, host.id));
					const conversationIds = listed.map((row) => row.conversation.id);
					const latest = yield* query((db) => latestMessages(db, conversationIds));
					const counts = yield* query((db) => messageCounts(db, conversationIds));
					const waitingOn = yield* query((db) => toolsAwaitingApproval(db, conversationIds));
					const marksOf = yield* conversationMarks(host.workspaceId, conversationIds);
					const mentioning = yield* query((db) => unreadMentionsIn(db, userId, conversationIds));
					const pinned = yield* query((db) => isPinnedBy(db, host.id, userId));
					const shownHost = toBot(personFacingHost, { actor, pinned });
					const tasks = listed.map((row): ChatListItem => {
						const last = latest.get(row.conversation.id);
						return {
							bot: shownHost,
							conversation: toTask(row.conversation),
							lastMessage: last
								? {
										preview: replyPreview(last),
										authorUserId: last.authorUserId,
										at: last.createdAt.toISOString(),
									}
								: null,
							participants: row.participants.map(toParticipant),
							messageCount: counts.get(row.conversation.id) ?? 0,
							waitingOn: waitingOn.get(row.conversation.id) || null,
							...marksOf(row.conversation.id),
							mentionsYou: mentioning.has(row.conversation.id),
						};
					});
					const owned = yield* query((db) => listedAutomations(db, host.id, userId));
					const feedMentions = yield* query((db) =>
						unreadMentionsIn(
							db,
							userId,
							owned.flatMap((row) => (row.feed ? [row.feed.id] : [])),
						),
					);
					const automations = owned.map((row) => ({
						automation: {
							id: row.automation.id,
							name: row.automation.name,
							state: row.automation.state,
							failed: row.failed,
							pausedAfterFailures: row.automation.pausedAfterFailuresAt !== null,
						},
						bot: shownHost,
						conversation: row.feed && toAutomationFeed(row.feed),
						mentionsYou: row.feed !== null && feedMentions.has(row.feed.id),
					}));
					const [summary] = yield* query((db) =>
						db
							.select({ content: botSummary.content, updatedAt: botSummary.updatedAt })
							.from(botSummary)
							.where(eq(botSummary.botId, host.id))
							.limit(1),
					);
					return {
						tasks: tasks.sort(byLatestMessage),
						automations,
						summary: summary
							? { content: summary.content, updatedAt: summary.updatedAt.toISOString() }
							: null,
					};
				}),
			),

		channelMarkers: (workspace) =>
			operation(
				"channelMarkers",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const reachesChannel = yield* visibility.reachesChannel;
					const reachesBot = yield* visibility.reachesBot;
					const chats = yield* query((db) =>
						channelConversationsReached(db, workspaceId, reachesChannel),
					);
					const botTasks = yield* query((db) =>
						botConversationsReached(db, workspaceId, reachesBot),
					);
					const marksOf = yield* conversationMarks(workspaceId, [
						...chats.map(({ id }) => id),
						...botTasks.map(({ id }) => id),
					]);
					const failed = yield* query((db) =>
						failedAutomationsByBot(db, workspaceId, reachesBot, userId),
					);
					const tally = <Marker extends ChannelMarker>(
						into: Record<string, Marker>,
						key: string,
						conversationId: string,
						nothing: Marker,
					) => {
						const { unreadMessages, needsApproval } = marksOf(conversationId);
						if (unreadMessages === 0 && !needsApproval) return;
						const marked = into[key] ?? nothing;
						into[key] = {
							...marked,
							unreadMessages: marked.unreadMessages + unreadMessages,
							needsApproval: marked.needsApproval || needsApproval,
						};
					};
					const channels: Record<string, ChannelMarker> = {};
					for (const chat of chats) tally(channels, chat.channelId, chat.id, NOTHING_NEW);
					const bots: Record<string, BotMarker> = {};
					for (const conversation of botTasks) {
						tally(bots, conversation.botId, conversation.id, NOTHING_NEW_FOR_BOT);
					}
					for (const [botId, failedAutomations] of failed) {
						bots[botId] = { ...(bots[botId] ?? NOTHING_NEW_FOR_BOT), failedAutomations };
					}
					return { channels, bots };
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
					const rows = yield* query((db) => directMessagesOf(db, workspaceId, actor.userId));
					const items = yield* directMessageItems(workspaceId, actor.userId, rows);
					return { items: items.sort(byLatestMessage) };
				}),
			),

		directMessage: (conversationId) =>
			operation(
				"directMessage",
				Effect.gen(function* () {
					const reached = yield* visibility.conversationStanding(conversationId);
					if (reached.kind !== "direct_message") {
						return yield* new ResourceHidden({ resource: "conversation" });
					}
					const { userId } = yield* CurrentActor.Service;
					const [item] = yield* directMessageItems(reached.conversation.workspaceId, userId, [
						reached.conversation,
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
					const reachesConversation = yield* visibility.reachesConversation;
					const waiting = yield* query((db) =>
						waitingApprovalRows(db, deciders.decidable, reachesConversation),
					);
					const answered = yield* query((db) =>
						answeredApprovalRows(db, workspaceId, reachesConversation),
					);
					return {
						waiting: waiting.map(toApprovalRequest),
						answered: answered.flatMap((row): AnsweredApproval[] => {
							const answer = answerOf(row);
							return answer ? [{ ...toApprovalRequest(row), answer }] : [];
						}),
					};
				}),
			),

		inbox: (workspace) =>
			operation(
				"inbox",
				Effect.gen(function* () {
					const scope = yield* inboxScopeOf(workspace);
					if (!scope) return { items: [] };
					const messages = yield* query((db) =>
						inboxMessageRows(db, scope, { onlyUnreadMentions: false, limit: INBOX_ITEMS }),
					);
					const runs = yield* query((db) => automationRunRows(db, scope));
					const collaborations = yield* query((db) => collaborationRows(db, scope));
					const items: InboxItem[] = [
						...messages.map(inboxMessageItem),
						...runs.map(
							(row): InboxItem => ({
								kind: "run",
								conversationId: row.conversationId,
								automationName: row.automationName,
								state: row.state,
								triggerKind: row.triggerKind,
								bot: { kind: "bot", ...row.bot },
								preview: row.lastReply && runReportPreview(row.lastReply),
								mentionsYou: row.mentionsYou,
								rootConversationId: row.rootConversationId,
								at: row.at.toISOString(),
								unread: row.unread,
							}),
						),
						...collaborations.map(
							(row): InboxItem => ({
								kind: "collaboration",
								conversationId: row.conversationId,
								initiator: { kind: "bot", ...row.initiator },
								recipient: { kind: "bot", ...row.recipient },
								status: row.status,
								brief: row.brief,
								rootConversationId: row.rootConversationId,
								at: row.at.toISOString(),
								unread: row.unread,
							}),
						),
					];
					return {
						items: items
							.sort((left, right) => right.at.localeCompare(left.at))
							.slice(0, INBOX_ITEMS),
					};
				}),
			),

		unreadMentions: (workspace, limit) =>
			operation(
				"unreadMentions",
				Effect.gen(function* () {
					const scope = yield* inboxScopeOf(workspace);
					if (!scope) return [];
					const messages = yield* query((db) =>
						inboxMessageRows(db, scope, { onlyUnreadMentions: true, limit }),
					);
					return messages.map(inboxMessageItem);
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
					const reachesConversation = yield* visibility.reachesConversation;
					const row = yield* query((db) =>
						loadMainPage(db, conversationId, reachesConversation, page.limit, before),
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
					const reachesConversation = yield* visibility.reachesConversation;
					const row = yield* query((db) =>
						loadHistory(db, conversationId, reachesConversation, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					return toHistoryPage(row, page.limit);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

/** A channel's marker before any of its conversations is counted. */
const NOTHING_NEW: ChannelMarker = { unreadMessages: 0, needsApproval: false };
/** A bot's marker before any of its conversations or automations is counted. */
const NOTHING_NEW_FOR_BOT: BotMarker = { ...NOTHING_NEW, failedAutomations: 0 };

export class InvalidPageCursor extends Data.TaggedError("InvalidPageCursor") implements UserFacing {
	get userMessage() {
		return userText`That page cursor is invalid`;
	}
}

/** The id of the channel `channelRef` names, by its id or its slug, when the actor reaches it. */
const reachableChannel = Effect.fn("ChatView.reachableChannel")(function* (
	db: Executor,
	channelRef: string,
	input: { workspaceId: string; reachesChannel: Visibility.ReachesChannel },
) {
	const [row] = yield* db
		.select({ id: channel.id })
		.from(channel)
		.where(
			and(
				isUuid(channelRef) ? eq(channel.id, channelRef) : eq(channel.slug, channelRef),
				eq(channel.workspaceId, input.workspaceId),
				input.reachesChannel(channel.id),
			),
		)
		.limit(1);
	return row?.id;
});

/** The tasks of the bot `botId`, most recently changed first, each with who has written in it lately. */
const tasksOf = Effect.fn("ChatView.tasksOf")(function* (db: Executor, botId: string) {
	return yield* db
		.select({
			conversation: getColumns(placedConversation),
			participants: recentParticipantsOf(placedConversation.id),
		})
		.from(task)
		.innerJoin(placedConversation, eq(placedConversation.id, task.conversationId))
		.where(eq(task.botId, botId))
		.orderBy(desc(placedConversation.updatedAt), desc(placedConversation.id));
});

/** Whether `userId` pinned the bot `botId`. */
const isPinnedBy = Effect.fn("ChatView.isPinnedBy")(function* (
	db: Executor,
	botId: string,
	userId: string,
) {
	const [row] = yield* db
		.select({ id: pinnedBot.botId })
		.from(pinnedBot)
		.where(and(eq(pinnedBot.botId, botId), eq(pinnedBot.userId, userId)))
		.limit(1);
	return row !== undefined;
});

/**
 * The automations of the bot `botId` that are still there, by name, each
 * with its conversation when it has one, and whether it failed since `userId` last
 * looked.
 */
const listedAutomations = Effect.fn("ChatView.listedAutomations")(function* (
	db: Executor,
	botId: string,
	userId: string,
) {
	const feed = alias(placedConversation, "feed");
	return yield* db
		.select({
			automation,
			feed: getColumns(feed),
			failed: latestRunFailedUnseen(automation.id, userId),
		})
		.from(automation)
		.leftJoin(feed, eq(feed.automationId, automation.id))
		.where(and(eq(automation.botId, botId), isNull(automation.deletedAt)))
		.orderBy(asc(automation.name), asc(automation.id));
});

/** The channel's conversations not archived: its main chat, then its threads in the order they were started. */
const channelConversations = Effect.fn("ChatView.channelConversations")(function* (
	db: Executor,
	channelId: string,
) {
	return yield* db
		.select()
		.from(placedConversation)
		.where(
			and(
				eq(placedConversation.kind, "channel_conversation"),
				eq(placedConversation.channelId, channelId),
				isNull(placedConversation.archivedAt),
			),
		)
		.orderBy(
			desc(placedConversation.main),
			asc(placedConversation.createdAt),
			asc(placedConversation.id),
		);
});

/** The conversations not archived of every channel in the workspace that `reachesChannel` reaches. */
const channelConversationsReached = Effect.fn("ChatView.channelConversationsReached")(function* (
	db: Executor,
	workspaceId: string,
	reachesChannel: Visibility.ReachesChannel,
) {
	const rows = yield* db
		.select({ id: placedConversation.id, channelId: placedConversation.channelId })
		.from(placedConversation)
		.where(
			and(
				eq(placedConversation.kind, "channel_conversation"),
				isNull(placedConversation.archivedAt),
				eq(placedConversation.workspaceId, workspaceId),
				reachesChannel(placedConversation.channelId),
			),
		);
	return rows.flatMap(({ id, channelId }) => (channelId ? [{ id, channelId }] : []));
});

/** The tasks and automation feeds of every bot in the workspace that `reachesBot` reaches. */
const botConversationsReached = Effect.fn("ChatView.botConversationsReached")(function* (
	db: Executor,
	workspaceId: string,
	reachesBot: Visibility.ReachesBot,
) {
	const rows = yield* db
		.select({ id: placedConversation.id, botId: placedConversation.botId })
		.from(placedConversation)
		.where(
			and(
				inArray(placedConversation.kind, ["task", "automation_feed"]),
				eq(placedConversation.workspaceId, workspaceId),
				reachesBot(placedConversation.botId),
			),
		);
	return rows.flatMap(({ id, botId }) => (botId ? [{ id, botId }] : []));
});

/** How many messages each of the conversations holds, by its id; one with none is left out. */
const messageCounts = Effect.fn("ChatView.messageCounts")(function* (
	db: Executor,
	conversationIds: readonly string[],
) {
	if (conversationIds.length === 0) return new Map<string, number>();
	const rows = yield* db
		.select({ conversationId: message.conversationId, count: count() })
		.from(message)
		.where(inArray(message.conversationId, [...conversationIds]))
		.groupBy(message.conversationId);
	return new Map(rows.map((row) => [row.conversationId, row.count]));
});

/** The newest message with words in it in each conversation, in one query. */
const latestMessages = Effect.fn("ChatView.latestMessages")(function* (
	db: Executor,
	conversationIds: readonly string[],
) {
	if (conversationIds.length === 0) {
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
		.selectDistinctOn([message.conversationId], {
			conversationId: message.conversationId,
			content: message.content,
			parts: message.parts,
			authorUserId: message.authorUserId,
			createdAt: message.createdAt,
		})
		.from(message)
		.where(and(inArray(message.conversationId, [...conversationIds]), ne(message.content, "")))
		.orderBy(message.conversationId, desc(message.createdAt));
	return new Map(rows.map((row) => [row.conversationId, row]));
});

/**
 * For each of the conversations with calls waiting for approval, the tool the first
 * would run in the newest reply that asked, whether or not it wrote anything.
 */
const toolsAwaitingApproval = Effect.fn("ChatView.toolsAwaitingApproval")(function* (
	db: Executor,
	conversationIds: readonly string[],
) {
	if (conversationIds.length === 0) return new Map<string, string>();
	const rows = yield* db
		.selectDistinctOn([toolCall.conversationId], {
			conversationId: toolCall.conversationId,
			tool: toolCall.tool,
		})
		.from(toolCall)
		.innerJoin(message, eq(message.id, toolCall.messageId))
		.where(
			and(
				inArray(toolCall.conversationId, [...conversationIds]),
				eq(toolCall.approvalStatus, "pending"),
			),
		)
		.orderBy(
			toolCall.conversationId,
			desc(message.createdAt),
			asc(toolCall.atOffset),
			asc(toolCall.id),
		);
	return new Map(rows.map((row) => [row.conversationId, row.tool]));
});

/**
 * How many messages with words in them somebody other than `userId` finished on
 * each of the conversations since `userId` caught up with it, by `caughtUpAt`.
 * Conversations with none are left out.
 */
const unreadMessageCounts = Effect.fn("ChatView.unreadMessageCounts")(function* (
	db: Executor,
	userId: string,
	conversationIds: readonly string[],
) {
	if (conversationIds.length === 0) return new Map<string, number>();
	const rows = yield* db
		.select({ conversationId: message.conversationId, count: sql<number>`count(*)::int` })
		.from(message)
		.where(
			and(
				inArray(message.conversationId, [...conversationIds]),
				finishedWordsFromOthers(userId),
				unreadBy(db, userId, { conversationId: message.conversationId, at: message.createdAt }),
			),
		)
		.groupBy(message.conversationId);
	return new Map(rows.map((row) => [row.conversationId, row.count]));
});

/** Those of the conversations with a message `userId` has not read that mentions them. */
const unreadMentionsIn = Effect.fn("ChatView.unreadMentionsIn")(function* (
	db: Executor,
	userId: string,
	conversationIds: readonly string[],
) {
	if (conversationIds.length === 0) return new Set<string>();
	const [person] = yield* db
		.select({ name: user.name })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (!person) return new Set<string>();
	const rows = yield* db
		.selectDistinct({ conversationId: message.conversationId })
		.from(message)
		.where(
			and(
				inArray(message.conversationId, [...conversationIds]),
				finishedWordsFromOthers(userId),
				mentions(handleFromName(person.name)),
				unreadBy(db, userId, { conversationId: message.conversationId, at: message.createdAt }),
			),
		);
	return new Set(rows.map((row) => row.conversationId));
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
 * `conversationId` at `at`, by `caughtUpAt`.
 */
function unreadBy(
	db: Executor,
	userId: string,
	{ conversationId, at }: { conversationId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`coalesce(${at} > ${caughtUpAt(db, userId, conversationId)}, true)`;
}

/**
 * Whether `userId` has yet to catch up with an automation run or collaboration
 * that began at `at`: neither the conversation it is in, `conversationId`,
 * nor its own conversation, `itemConversationId`, read past when it began. Opening the
 * item from Inbox reads its own conversation, so it reads that item alone.
 */
function itemUnreadBy(
	db: Executor,
	userId: string,
	{
		conversationId,
		itemConversationId,
		at,
	}: { conversationId: SQLWrapper; itemConversationId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`(${unreadBy(db, userId, { conversationId: conversationId, at })} and ${unreadBy(db, userId, { conversationId: itemConversationId, at })})`;
}

/**
 * When `userId` last caught up with `conversationId`: the later of how far they
 * have read it and the last message they wrote there, or null when neither.
 *
 * A reply is stamped when it began. Reading never moves past a reply still
 * being written, so one the person read around still counts once it is done.
 * Writing does: a reply that began before the person's last message counts
 * as caught up with, even if it finished after, because a message does not
 * keep when it finished.
 */
function caughtUpAt(db: Executor, userId: string, conversationId: SQLWrapper): SQL<Date | null> {
	const own = alias(message, "own_message");
	// Through `sql`, because a timestamp column selected bare is cast to text for reading.
	const readThrough = db
		.select({ at: sql`${conversationRead.readThrough}` })
		.from(conversationRead)
		.where(
			and(
				sql`${conversationRead.conversationId} = ${conversationId}`,
				eq(conversationRead.userId, userId),
			),
		);
	const lastWritten = db
		.select({ at: sql`max(${own.createdAt})` })
		.from(own)
		.where(and(sql`${own.conversationId} = ${conversationId}`, eq(own.authorUserId, userId)));
	return sql<Date | null>`greatest((${readThrough}), (${lastWritten}))`;
}

/**
 * Whether a `message` mentions `handle`, or is a person's `@here` or
 * `@channel` where `groupsMention` holds. A bot's or an automation's notifies
 * nobody, so it mentions nobody.
 */
function mentions(handle: string, groupsMention: SQL = sql`true`): SQL {
	return sql`(${message.content} ~* ${mentionPattern(handle)} or (${message.authorUserId} is not null and ${groupsMention} and ${message.content} ~* ${mentionPattern(...GROUP_MENTION_HANDLES)}))`;
}

/** How far back the inbox looks: past this, a conversation is old news, read or not. */
const INBOX_WINDOW_DAYS = 30;
/** The most messages the inbox lists. */
const INBOX_ITEMS = 50;

/**
 * The newest `limit` messages in the conversations `userId` reaches, since
 * `since`, written by somebody else and either mentioning them or not yet
 * read (both, with `onlyUnreadMentions`), with their authors.
 */
const inboxMessageRows = Effect.fn("ChatView.inboxMessageRows")(function* (
	db: Executor,
	input: InboxScope,
	{ onlyUnreadMentions, limit }: { onlyUnreadMentions: boolean; limit: number },
) {
	// `@here` and `@channel` are text in a direct message, where everybody is told of every message.
	const mentionsYou = mentions(input.handle, sql`${placedConversation.kind} <> 'direct_message'`);
	const unread = unreadBy(db, input.userId, {
		conversationId: message.conversationId,
		at: message.createdAt,
	});
	const author = alias(bot, "author_bot");
	return yield* db
		.select({
			id: message.id,
			parts: message.parts,
			content: message.content,
			createdAt: message.createdAt,
			channelId: placedConversation.channelId,
			conversationId: placedConversation.id,
			authorUser: { id: user.id, name: user.name, email: user.email, image: user.image },
			authorBot: {
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
			placedConversation,
			and(
				eq(placedConversation.id, message.conversationId),
				// The conversations whose messages notify people are the ones Inbox shows.
				inArray(placedConversation.kind, [...NOTIFYING_CONVERSATION_KINDS]),
			),
		)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(author, eq(author.id, message.authorBotId))
		.where(
			and(
				eq(placedConversation.workspaceId, input.workspaceId),
				input.reachesConversation(placedConversation),
				gt(message.createdAt, input.since),
				finishedWordsFromOthers(input.userId),
				onlyUnreadMentions ? and(mentionsYou, unread) : or(mentionsYou, unread),
			),
		)
		.orderBy(desc(message.createdAt))
		.limit(limit);
});

/** A message row as the inbox lists it. */
function inboxMessageItem(
	row: Effect.Success<ReturnType<typeof inboxMessageRows>>[number],
): InboxItem {
	return {
		kind: row.mentionsYou ? "mention" : "message",
		messageId: row.id,
		author: toParticipant(authorRow(row.authorUser, row.authorBot)),
		preview: replyPreview(row),
		channelId: row.channelId,
		rootConversationId: row.conversationId,
		at: row.createdAt.toISOString(),
		unread: row.unread,
	};
}

interface InboxScope {
	workspaceId: string;
	reachesConversation: Visibility.ReachesConversation;
	userId: string;
	/** The person's handle, which mentions of them use. */
	handle: string;
	since: Date;
}

/** The newest finished reply with words in it a bot wrote in `conversationId`, or null when it has written none. */
function lastReplyIn(db: Executor, conversationId: SQLWrapper): SQL<Reply | null> {
	const reply = alias(message, "last_reply");
	const latest = db
		.select({ reply: sql`json_build_object('content', ${reply.content}, 'parts', ${reply.parts})` })
		.from(reply)
		.where(
			and(
				sql`${reply.conversationId} = ${conversationId}`,
				sql`${reply.authorBotId} is not null`,
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
 * The start of an automation run's report. A report often opens with a heading,
 * so its lines run together, and the preview reads past the heading.
 */
function runReportPreview(reply: Reply): string {
	return messagePreview(spokenText(reply).replace(/\s+/g, " "));
}

/** What `reply` says as a conversation shows it, without the narration before its tool calls. */
function spokenText(reply: Reply): string {
	return textWithoutNarration(reply.parts) || reply.content;
}

/**
 * The bots `reachesBot` reaches with automations whose latest run failed
 * since `userId` last looked, and how many each has.
 */
const failedAutomationsByBot = Effect.fn("ChatView.failedAutomationsByBot")(function* (
	db: Executor,
	workspaceId: string,
	reachesBot: Visibility.ReachesBot,
	userId: string,
) {
	const rows = yield* db
		.select({ botId: automation.botId, count: sql<number>`count(*)::int` })
		.from(automation)
		.where(
			and(
				eq(automation.workspaceId, workspaceId),
				isNull(automation.deletedAt),
				reachesBot(automation.botId),
				latestRunFailedUnseen(automation.id, userId),
			),
		)
		.groupBy(automation.botId);
	return new Map(rows.map((row) => [row.botId, row.count] as const));
});

/**
 * The automation runs in the conversations `userId` reaches since `since`, newest
 * first, with their last replies, but not those that completed with nothing to
 * report. A run is unread news only once it posted a result or failed, from
 * when it ended. It mentions the person when its result, posted only in the
 * automation's feed, does.
 */
const automationRunRows = Effect.fn("ChatView.automationRunRows")(function* (
	db: Executor,
	input: InboxScope,
) {
	const conversation = alias(placedConversation, "conversation");
	const posted = resultPosted(automationRun.id);
	const elsewhere = alias(message, "result_elsewhere");
	const resultMentioningYou = db
		.select({ id: message.id })
		.from(message)
		.where(
			and(
				eq(message.runId, automationRun.id),
				eq(message.conversationId, conversation.id),
				mentions(input.handle),
				sql`not exists (${db
					.select({ id: elsewhere.id })
					.from(elsewhere)
					.where(
						and(
							eq(elsewhere.runId, automationRun.id),
							ne(elsewhere.conversationId, conversation.id),
						),
					)})`,
			),
		);
	const isNews = or(eq(automationRun.state, "failed"), posted);
	return yield* db
		.select({
			conversationId: automationRun.conversationId,
			automationName: automationRun.automationName,
			state: automationRun.state,
			triggerKind: automationRun.triggerKind,
			at: automationRun.acceptedAt,
			bot: {
				id: bot.id,
				name: bot.name,
				handle: bot.handle,
				color: bot.color,
				face: bot.face,
				shape: bot.shape,
			},
			rootConversationId: conversation.id,
			unread: sql<boolean>`(${isNews} and ${itemUnreadBy(db, input.userId, {
				conversationId: conversation.id,
				itemConversationId: automationRun.conversationId,
				at: sql`coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt})`,
			})})`,
			mentionsYou: sql<boolean>`exists (${resultMentioningYou})`,
			lastReply: lastReplyIn(db, automationRun.conversationId),
		})
		.from(automationRun)
		.innerJoin(placedConversation, eq(placedConversation.id, automationRun.conversationId))
		.innerJoin(conversation, eq(conversation.id, placedConversation.rootConversationId))
		.innerJoin(bot, eq(bot.id, automationRun.botId))
		.where(
			and(
				eq(conversation.workspaceId, input.workspaceId),
				input.reachesConversation(conversation),
				gt(automationRun.acceptedAt, input.since),
				or(ne(automationRun.state, "completed"), posted),
			),
		)
		.orderBy(desc(automationRun.acceptedAt))
		.limit(INBOX_ITEMS);
});

/**
 * The collaborations one bot opened with another in the conversations
 * `userId` reaches since `since`, newest first, with both bots.
 */
const collaborationRows = Effect.fn("ChatView.collaborationRows")(function* (
	db: Executor,
	input: InboxScope,
) {
	const asked = alias(placedConversation, "asked_conversation");
	const askingMessage = alias(message, "asking_message");
	const initiator = alias(bot, "initiator");
	const recipient = alias(bot, "recipient");
	const conversation = alias(placedConversation, "conversation");
	return yield* db
		.select({
			conversationId: collaboration.conversationId,
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
			rootConversationId: conversation.id,
			unread: itemUnreadBy(db, input.userId, {
				conversationId: conversation.id,
				itemConversationId: collaboration.conversationId,
				at: collaboration.createdAt,
			}),
		})
		.from(collaboration)
		.innerJoin(asked, eq(asked.id, collaboration.conversationId))
		.innerJoin(conversation, eq(conversation.id, asked.rootConversationId))
		.innerJoin(askingMessage, eq(askingMessage.id, collaboration.parentMessageId))
		.innerJoin(initiator, eq(initiator.id, askingMessage.authorBotId))
		.innerJoin(recipient, eq(recipient.id, collaboration.collaboratorBotId))
		.where(
			and(
				eq(conversation.workspaceId, input.workspaceId),
				input.reachesConversation(conversation),
				gt(collaboration.createdAt, input.since),
			),
		)
		.orderBy(desc(collaboration.createdAt))
		.limit(INBOX_ITEMS);
});

/** How many answered approvals the inbox lists, newest first. */
const ANSWERED_APPROVALS = 50;
/** At most this many waiting approvals are listed; more than this many waiting is a backlog to clear in its conversations. */
const WAITING_APPROVALS = 100;

/**
 * Which approvals `userId` may decide in the conversations they reach, by
 * `mayDecideToolCall`, the rule deciding an approval checks: by their
 * standing in the channel or towards the bot of the conversation a conversation
 * belongs to, and, for a request to change a bot's computer, towards that bot.
 */
const approvalDecidersIn = Effect.fn("ChatView.approvalDecidersIn")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const bots = new Map(
		(yield* botStandingsFor(db, workspaceId, userId)).map((standing) => [
			standing.bot.id,
			standing,
		]),
	);
	const channels = new Map(
		(yield* reachedChannelStandingsFor(db, workspaceId, userId)).map((standing) => [
			standing.channel.id,
			standing,
		]),
	);
	/** The person's standing towards a conversation in the channel `channelId`, or else hosted by the bot `hostBotId`. */
	const standingIn = (conversation: {
		channelId: string | null;
		hostBotId: string | null;
	}): DecidingStanding | undefined => {
		if (conversation.channelId !== null) {
			const standing = channels.get(conversation.channelId);
			return standing && { kind: "channel", standing };
		}
		const standing = conversation.hostBotId === null ? undefined : bots.get(conversation.hostBotId);
		return standing && { kind: "bot", standing };
	};
	/** `conversation` is the one the call's conversation belongs to; `askingBotId` the bot that raised it. */
	const mayDecide = (
		conversation: { channelId: string | null; hostBotId: string | null },
		askingBotId: string,
		inAutomation: boolean,
		deciders: ToolApprovalDeciders,
	) => mayDecideToolCall(standingIn(conversation), bots.get(askingBotId), inAutomation, deciders);
	const botIds = [...bots.keys()];
	const decidable: Decidable = {
		channelsDeciding: [...channels.keys()].filter((channelId) =>
			channels.get(channelId)?.may("approval.decide"),
		),
		outsideAutomations: botIds.filter((botId) =>
			mayDecide({ channelId: null, hostBotId: botId }, botId, false, "conversation"),
		),
		inAutomations: botIds.filter((botId) =>
			mayDecide({ channelId: null, hostBotId: botId }, botId, true, "conversation"),
		),
		computerRequests: botIds.filter((botId) =>
			mayDecide({ channelId: null, hostBotId: null }, botId, false, "computer-managers"),
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
	channelsDeciding: readonly string[];
	outsideAutomations: readonly string[];
	inAutomations: readonly string[];
	computerRequests: readonly string[];
}

/**
 * The tool calls waiting on a decision `decidable` allows, in conversations
 * `reachesConversation` reaches, oldest first, each with the bot that asked and its
 * conversation.
 */
const waitingApprovalRows = Effect.fn("ChatView.waitingApprovalRows")(function* (
	db: Executor,
	decidable: Decidable,
	reachesConversation: Visibility.ReachesConversation,
) {
	const asking = alias(placedConversation, "asking_conversation");
	const conversation = alias(placedConversation, "approval_conversation");
	const computerRequest = inArray(toolCall.tool, [...COMPUTER_REQUEST_TOOLS]);
	const inAutomation = isNotNull(runIdOf(asking.id));
	const conditions: SQL[] = [];
	if (decidable.channelsDeciding.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and ${inArray(conversation.channelId, [...decidable.channelsDeciding])}`,
		);
	}
	if (decidable.outsideAutomations.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and ${inArray(conversation.botId, [...decidable.outsideAutomations])} and not ${inAutomation}`,
		);
	}
	if (decidable.inAutomations.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and ${inArray(conversation.botId, [...decidable.inAutomations])} and ${inAutomation}`,
		);
	}
	if (decidable.computerRequests.length > 0) {
		conditions.push(
			sql`${computerRequest} and ${inArray(turn.botId, [...decidable.computerRequests])}`,
		);
	}
	if (conditions.length === 0) return [];
	return yield* selectApprovals(db, asking, conversation)
		.where(
			and(eq(toolCall.approvalStatus, "pending"), or(...conditions), reachesConversation(asking)),
		)
		.orderBy(asc(toolCall.startedAt))
		.limit(WAITING_APPROVALS);
});

/**
 * The tool calls answered in conversations `reachesConversation` reaches, newest answer
 * first, each with the bot that asked and its conversation.
 */
const answeredApprovalRows = Effect.fn("ChatView.answeredApprovalRows")(function* (
	db: Executor,
	workspaceId: string,
	reachesConversation: Visibility.ReachesConversation,
) {
	const asking = alias(placedConversation, "asking_conversation");
	const conversation = alias(placedConversation, "approval_conversation");
	return yield* selectApprovals(db, asking, conversation)
		.where(
			and(
				eq(asking.workspaceId, workspaceId),
				inArray(toolCall.approvalStatus, ["allowed", "denied"]),
				isNotNull(toolCall.decidedAt),
				reachesConversation(asking),
			),
		)
		.orderBy(desc(toolCall.decidedAt))
		.limit(ANSWERED_APPROVALS);
});

/**
 * Tool calls with the bot that asked, the conversation they are in, and who answered.
 * `asking` is the conversation a call was made in, aliased because
 * `runIdOf` reads `conversation` itself.
 */
function selectApprovals(
	db: Executor,
	asking: AskingConversation,
	conversation: ApprovalConversation,
) {
	const decider = alias(user, "decider");
	return db
		.select({
			call: toolCall,
			// A collaboration's is the channel of the conversation it was opened from.
			channelId: conversation.channelId,
			rootConversationId: asking.rootConversationId,
			bot: {
				id: bot.id,
				name: bot.name,
				handle: bot.handle,
				color: bot.color,
				face: bot.face,
				shape: bot.shape,
			},
			decidedByName: decider.name,
		})
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.conversationId))
		.innerJoin(conversation, eq(conversation.id, asking.rootConversationId))
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(bot, eq(bot.id, turn.botId))
		.leftJoin(decider, eq(decider.id, toolCall.decidedById))
		.$dynamic();
}

type AskingConversation = ReturnType<
	typeof alias<typeof placedConversation, "asking_conversation">
>;

/** The conversation the asking conversation belongs to. */
type ApprovalConversation = ReturnType<
	typeof alias<typeof placedConversation, "approval_conversation">
>;

type ApprovalRow = Effect.Success<ReturnType<typeof answeredApprovalRows>>[number];

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
	return {
		call: toToolCallPart(row.call, row.decidedByName),
		bot: { kind: "bot", ...row.bot },
		channelId: row.channelId,
		conversationId: row.call.conversationId,
		rootConversationId: row.rootConversationId,
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
		// Aliased, because `runIdOf` reads `conversation` itself, and an
		// unaliased column would name its row rather than this one.
		const asking = alias(placedConversation, "asking_conversation");
		const conversation = alias(placedConversation, "approval_conversation");
		const pending = yield* db
			.selectDistinct({
				rootConversationId: asking.rootConversationId,
				channelId: conversation.channelId,
				hostBotId: conversation.botId,
				botId: turn.botId,
				runId: runIdOf(asking.id),
				tool: toolCall.tool,
			})
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.conversationId))
			.innerJoin(conversation, eq(conversation.id, asking.rootConversationId))
			.innerJoin(turn, eq(turn.id, toolCall.turnId))
			.where(
				and(
					inArray(asking.rootConversationId, [...conversationIds]),
					eq(toolCall.approvalStatus, "pending"),
				),
			);
		if (pending.length === 0) return new Set<string>();
		const { mayDecide } = yield* approvalDecidersIn(db, workspaceId, userId);
		return new Set(
			// The conversations are ones the person reaches, so their standing decides.
			pending.flatMap(({ rootConversationId, channelId, hostBotId, botId, runId, tool }) =>
				rootConversationId &&
				mayDecide({ channelId, hostBotId }, botId, runId !== null, decidersOf(tool))
					? [rootConversationId]
					: [],
			),
		);
	},
);

/** The direct messages `userId` is in, in the workspace. */
const directMessagesOf = Effect.fn("ChatView.directMessagesOf")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select({ conversation: getColumns(placedConversation) })
		.from(directMessageMember)
		.innerJoin(placedConversation, eq(placedConversation.id, directMessageMember.conversationId))
		.where(
			and(eq(directMessageMember.userId, userId), eq(placedConversation.workspaceId, workspaceId)),
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
	conversations: readonly PlacedConversationRow[],
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
		const conversationIds = conversations.map((conversation) => conversation.id);
		const { latest, unread, present } = yield* Effect.all(
			{
				latest: query((db) => latestMessages(db, conversationIds)),
				unread: query((db) => unreadMessageCounts(db, userId, conversationIds)),
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
				conversation: toDirectMessage(conversation),
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
 * when `reachesConversation` does not reach the conversation.
 */
const loadMainPage = Effect.fn("ChatView.loadMainPage")(function* (
	db: Executor,
	conversationId: string,
	reachesConversation: Visibility.ReachesConversation,
	limit: number,
	before: CursorPoint | undefined,
) {
	const conversation = yield* db.query.placedConversation.findFirst({
		where: {
			id: conversationId,
			kind: { in: [...OPENABLE_CONVERSATION_KINDS] },
			RAW: (row) => reachesConversation(row),
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
	const automationRuns = yield* db.query.automationRun.findMany({
		limit: limit + 1,
		orderBy: { acceptedAt: "desc", id: "desc" },
		where: {
			RAW: (row) =>
				and(
					// Each run of an automation is listed in its feed.
					sql`${row.automationId} in (select ${automationFeed.automationId} from ${automationFeed} where ${automationFeed.conversationId} = ${conversationId})`,
					before && earlierThan(row.acceptedAt, row.id, before),
				) ?? sql`true`,
		},
		columns: {
			id: true,
			conversationId: true,
			automationName: true,
			triggerKind: true,
			acceptedAt: true,
			state: true,
			error: true,
		},
		extras: {
			report: (row) => lastReplyIn(db, row.conversationId),
			posted: (row) => resultPosted(sql`${row.id}`),
		},
	});
	const [paused] = yield* db
		.select({ automationId: automation.id, at: automation.pausedAfterFailuresAt })
		.from(automation)
		.innerJoin(placedConversation, eq(placedConversation.automationId, automation.id))
		.where(eq(placedConversation.id, conversationId))
		.limit(1);
	// On the page whose span it falls in: the first, or one before where it happened.
	const pausedAfterFailures =
		paused?.at && (!before || paused.at < before.at)
			? { automationId: paused.automationId, at: paused.at }
			: null;
	return { ...conversation, automationRuns, pausedAfterFailures };
});

/** The status of the newest turn in `conversationId`, or null when it has none. */
function latestTurnStatusIn(conversationId: SQLWrapper): SQL<schema.TurnRow["status"] | null> {
	return sql<schema.TurnRow["status"] | null>`(
		select ${turn.status} from ${turn}
		where ${turn.conversationId} = ${conversationId}
		order by ${turn.startedAt} desc, ${turn.id} desc
		limit 1
	)`;
}

type MainPage = NonNullable<Effect.Success<ReturnType<typeof loadMainPage>>>;

/** The automation `automationId` pausing itself at `at`, as a page lists it, by the automation's id. */
function pausedCandidate(automationId: string, at: Date) {
	return {
		id: automationId,
		createdAt: at,
		item: (): ChatMessageItem => ({
			kind: "automation_paused",
			id: automationId,
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
			? [pausedCandidate(row.pausedAfterFailures.automationId, row.pausedAfterFailures.at)]
			: []),
		// A run that posted its result is shown by the post, which opens the run.
		...row.automationRuns
			.filter((execution) => !execution.posted)
			.map((execution) => ({
				id: execution.id,
				createdAt: execution.acceptedAt,
				item: (): ChatMessageItem => ({
					kind: "run",
					id: execution.id,
					conversationId: execution.conversationId,
					automationName: execution.automationName,
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
 * A page of the conversations opened beside the conversation, one statement: its
 * automation runs and collaborations, each newest activity first and one more
 * than the page. Nothing when `reachesConversation` does not reach the
 * conversation.
 */
const loadHistory = Effect.fn("ChatView.loadHistory")(function* (
	db: Executor,
	conversationId: string,
	reachesConversation: Visibility.ReachesConversation,
	limit: number,
	before: CursorPoint | undefined,
) {
	const items = {
		limit: limit + 1,
		orderBy: { updatedAt: "desc", id: "desc" },
		where: {
			kind: { in: ["collaboration", "run"] },
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
				with: { user: personColumns, bot: botColumns },
			},
			automationRun: {
				columns: { id: true, automationId: true, automationName: true, trigger: true, state: true },
			},
		},
	} satisfies DBQueryConfig<"many", typeof relations, (typeof relations)["placedConversation"]>;
	return yield* db.query.placedConversation.findFirst({
		where: {
			id: conversationId,
			kind: { in: [...OPENABLE_CONVERSATION_KINDS] },
			RAW: (row) => reachesConversation(row),
		},
		columns: { id: true },
		with: { rootedConversations: items },
	});
});

type HistoryRow = NonNullable<Effect.Success<ReturnType<typeof loadHistory>>>;

/** The collaborations and runs, loaded newest activity first, cut to the page. */
function toHistoryPage(row: HistoryRow, limit: number) {
	const rooted = row.rootedConversations;
	const page = rooted.slice(0, limit);
	const items = page.flatMap((side): ChatHistoryEntry[] => {
		if (side.kind !== "collaboration" && side.kind !== "run") return [];
		// A run's own row; a collaboration has none.
		const execution = side.kind === "run" ? side.automationRun : null;
		return [
			{
				conversationId: side.id,
				parentConversationId: side.parentConversationId,
				kind: side.kind,
				title: side.title,
				participants: side.participants.map(({ user: person, bot: participant }) =>
					toParticipant(authorRow(person, participant)),
				),
				status: execution
					? execution.state
					: side.running
						? "running"
						: side.latestTurnStatus === "failed"
							? "failed"
							: "completed",
				automationRun: execution
					? {
							runId: execution.id,
							automationId: execution.automationId,
							automationName: execution.automationName,
							triggerKind: execution.trigger.kind,
							triggeredAt:
								execution.trigger.kind === "schedule"
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
			rooted.length > limit && oldest
				? encodeCursor({ at: oldest.updatedAt, id: oldest.id })
				: null,
	};
}

const pageCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidPageCursor());
};

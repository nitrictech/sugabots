export * as ChatView from "./chat-view.ts";

import type {
	AnsweredApproval,
	ApprovalInbox,
	ApprovalRequest,
	AttentionCounts,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	ConversationKind,
	ConversationPlace,
	InboxFeed,
	InboxItem,
	ListedThread,
	ProjectMarker,
	ProjectThreadList,
	ProjectThreadMarkers,
	ThreadActivity,
	ToolApprovalDeciders,
} from "@sugabots/contracts";
import {
	DEFAULT_CHAT_PAGE_LIMIT,
	GROUP_MENTION_HANDLES,
	handleFromName,
	mentionPattern,
	messagePreview,
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
	computerProjectIdOf,
	mayDecideToolCall,
	projectStandingsFor,
	projectStandingsOf,
	ResourceHidden,
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
	collaboration,
	conversationRead,
	message,
	OPENABLE_CONVERSATION_KINDS,
	placedConversation,
	toolCall,
	turn,
	user,
} from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import {
	latestRunOf,
	listStatusColumns,
	resultPosted,
	runIdOf,
	toListStatus,
	unseenAutomationFailure,
} from "../automations/execution.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import {
	authorRow,
	botColumns,
	messageFromRelations,
	messageRelations,
	namedPersonColumns,
	personColumns,
	recentParticipantsOf,
	toParticipant,
} from "../repository/participants.ts";
import { toToolCallPart } from "../repository/tool-calls.ts";
import { COMPUTER_REQUEST_TOOLS, decidersOf } from "../tools/approval-deciders.ts";
import { Turns } from "../turns/turns.ts";
import { toAutomationFeed, toProjectThread } from "./conversation.ts";

/**
 * What the chat screens show, of the conversations the current actor can see:
 * a project's threads (a bot's are its default project's), and a
 * conversation's two timelines.
 */
export interface Interface {
	/**
	 * The threads and automations of the project `projectId`, a bot's default
	 * project included. Hidden unless the actor reaches it.
	 */
	readonly threads: (
		projectId: string,
	) => Effect.Effect<ProjectThreadList, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How each project of the workspace the actor reaches, bots' default
	 * projects included, stands for them: its threads' and automation feeds'
	 * unread messages, whether any waits on their decision, and how many of its
	 * automations are failing unseen.
	 */
	readonly projectMarkers: (
		workspace: string,
	) => Effect.Effect<ProjectThreadMarkers, AuthorizationDenied, CurrentActor.Service>;
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
	/**
	 * How much in the workspace waits for the actor, over the inbox's window,
	 * counted in full rather than over the inbox's latest items.
	 */
	readonly attention: (
		workspace: string,
	) => Effect.Effect<AttentionCounts, AuthorizationDenied, CurrentActor.Service>;
	/** The newest `limit` messages in the inbox that mention the actor and they have not read. */
	readonly unreadMentions: (
		workspace: string,
		limit: number,
	) => Effect.Effect<UnreadMention[], AuthorizationDenied, CurrentActor.Service>;
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

	/** What the inbox looks through for the actor in `workspace`. */
	const inboxScopeOf = (workspace: string) =>
		Effect.gen(function* () {
			const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
			const { userId } = yield* CurrentActor.Service;
			return yield* inboxScopeIn({
				workspaceId,
				userId,
				reachesConversation: yield* visibility.reachesConversation,
			});
		});

	/**
	 * The threads `rows` as a project's list shows them to `userId`: each with
	 * its latest message, how many it holds, who has written in it lately,
	 * and how it stands for them, newest message first.
	 */
	const listedThreads = Effect.fn("ChatView.listedThreads")(function* (
		workspaceId: string,
		userId: string,
		rows: readonly ThreadRow[],
	) {
		const conversationIds = rows.map((row) => row.conversation.id);
		const latest = yield* query((db) => latestMessages(db, conversationIds));
		const counts = yield* query((db) => messageCounts(db, conversationIds));
		const marksOf = yield* conversationMarks(workspaceId, conversationIds);
		const mentioning = yield* query((db) => unreadMentionsIn(db, userId, conversationIds));
		const activities = yield* threadActivities(userId, conversationIds);
		const listed = rows.map((row): ListedThread => {
			const last = latest.get(row.conversation.id);
			return {
				conversation: toProjectThread(row.conversation),
				lastMessage: last
					? {
							preview: replyPreview(last),
							authorUserId: last.authorUserId,
							at: last.createdAt.toISOString(),
						}
					: null,
				participants: row.participants.map(toParticipant),
				messageCount: counts.get(row.conversation.id) ?? 0,
				...marksOf(row.conversation.id),
				mentionsYou: mentioning.has(row.conversation.id),
				activity: activities.get(row.conversation.id) ?? null,
			};
		});
		return listed.sort(byLatestMessage);
	});

	return Service.of({
		threads: (projectId) =>
			operation(
				"threads",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("conversation.list.project", projectId);
					const standing = yield* authorization.project(projectId, "project.read");
					const { project: listed, actor } = standing;
					const { userId } = actor;
					const rows = yield* query((db) => projectThreads(db, listed.id));
					const threads = yield* listedThreads(listed.workspaceId, userId, rows);
					const owned = yield* query((db) => listedAutomations(db, listed.id));
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
							pausedAfterFailures: row.automation.pausedAfterFailuresAt !== null,
						},
						conversation: row.feed && toAutomationFeed(row.feed),
						mentionsYou: row.feed !== null && feedMentions.has(row.feed.id),
						status: toListStatus(row),
					}));
					return { threads, automations };
				}),
			),

		projectMarkers: (workspace) =>
			operation(
				"projectMarkers",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const reachesProject = yield* visibility.reachesProject;
					const conversations = yield* query((db) =>
						projectConversationsReached(db, workspaceId, reachesProject),
					);
					const marksOf = yield* conversationMarks(
						workspaceId,
						conversations.map(({ id }) => id),
					);
					const failed = yield* query((db) =>
						failingAutomationsByProject(db, workspaceId, reachesProject, userId),
					);
					const projects: Record<string, ProjectMarker> = {};
					for (const { id, projectId } of conversations) {
						const { unreadMessages, needsApproval } = marksOf(id);
						if (unreadMessages === 0 && !needsApproval) continue;
						const marked = projects[projectId] ?? NOTHING_NEW;
						projects[projectId] = {
							...marked,
							unreadMessages: marked.unreadMessages + unreadMessages,
							needsApproval: marked.needsApproval || needsApproval,
						};
					}
					for (const [projectId, failedAutomations] of failed) {
						projects[projectId] = { ...(projects[projectId] ?? NOTHING_NEW), failedAutomations };
					}
					return { projects };
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
								place: placeOf(row.place),
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
								place: placeOf(row.place),
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

		attention: (workspace) =>
			operation(
				"attention",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { userId } = yield* CurrentActor.Service;
					const deciders = yield* query((db) => approvalDecidersIn(db, workspaceId, userId));
					const reachesConversation = yield* visibility.reachesConversation;
					const waitingApprovals = yield* query((db) =>
						waitingApprovalCount(db, deciders.decidable, reachesConversation),
					);
					const scope = yield* inboxScopeIn({ workspaceId, userId, reachesConversation });
					const messages = yield* query((db) => inboxMessageCounts(db, scope));
					const runs = yield* query((db) => inboxRunCounts(db, scope));
					const collaborations = yield* query((db) => inboxCollaborationsUnread(db, scope));
					return {
						unreadInInbox: messages.unread + runs.unread + collaborations,
						waitingApprovals,
						unreadForYou: messages.unreadMentions + runs.unreadMentions,
					};
				}),
			),

		unreadMentions: (workspace, limit) =>
			operation(
				"unreadMentions",
				Effect.gen(function* () {
					const scope = yield* inboxScopeOf(workspace);
					const messages = yield* query((db) =>
						inboxMessageRows(db, scope, { onlyUnreadMentions: true, limit }),
					);
					return messages.map(
						(row): UnreadMention => ({
							messageId: row.id,
							authorName: toParticipant(authorRow(row.authorUser, row.authorBot)).name,
							preview: replyPreview(row),
							rootConversationId: row.conversationId,
						}),
					);
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

/** A project's marker before any of its conversations or automations is counted. */
const NOTHING_NEW: ProjectMarker = {
	unreadMessages: 0,
	needsApproval: false,
	failedAutomations: 0,
};

export class InvalidPageCursor extends Data.TaggedError("InvalidPageCursor") implements UserFacing {
	get userMessage() {
		return userText`That page cursor is invalid`;
	}
}

/**
 * The project `projectId`'s automations that are still there, by name, each
 * with its conversation when it has one, its latest run and whether it is
 * failing.
 */
const listedAutomations = Effect.fn("ChatView.listedAutomations")(function* (
	db: Executor,
	projectId: string,
) {
	const feed = alias(placedConversation, "feed");
	const latest = latestRunOf(db);
	return yield* db
		.select({
			automation,
			feed: getColumns(feed),
			...listStatusColumns(latest),
		})
		.from(automation)
		.leftJoin(feed, eq(feed.automationId, automation.id))
		.leftJoinLateral(latest, sql`true`)
		.where(and(eq(automation.projectId, projectId), isNull(automation.deletedAt)))
		.orderBy(asc(automation.name), asc(automation.id));
});

/** One of the threads a list shows, with who has written in it lately. */
type ThreadRow = Effect.Success<ReturnType<typeof projectThreads>>[number];

/**
 * The project's threads not archived, most recently changed first, each with
 * who has written in it lately.
 */
const projectThreads = Effect.fn("ChatView.projectThreads")(function* (
	db: Executor,
	projectId: string,
) {
	return yield* db
		.select({
			conversation: getColumns(placedConversation),
			participants: recentParticipantsOf(placedConversation.id),
		})
		.from(placedConversation)
		.where(
			and(
				eq(placedConversation.kind, "project_thread"),
				eq(placedConversation.projectId, projectId),
				isNull(placedConversation.archivedAt),
			),
		)
		.orderBy(desc(placedConversation.updatedAt), desc(placedConversation.id));
});

/**
 * The threads not archived and the automation feeds of every project in the
 * workspace that `reachesProject` reaches, bots' default projects included.
 */
const projectConversationsReached = Effect.fn("ChatView.projectConversationsReached")(function* (
	db: Executor,
	workspaceId: string,
	reachesProject: Visibility.ReachesProject,
) {
	const rows = yield* db
		.select({ id: placedConversation.id, projectId: placedConversation.projectId })
		.from(placedConversation)
		.where(
			and(
				or(
					and(eq(placedConversation.kind, "project_thread"), isNull(placedConversation.archivedAt)),
					eq(placedConversation.kind, "automation_feed"),
				),
				eq(placedConversation.workspaceId, workspaceId),
				reachesProject(placedConversation.projectId),
			),
		);
	return rows.flatMap(({ id, projectId }) => (projectId ? [{ id, projectId }] : []));
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

/**
 * What the bots are doing in each of the conversations, as `userId`'s list
 * shows it, by its id; one with nothing to show is left out. A turn waiting on
 * an approval comes first, as it waits on a person; then a turn working on a
 * reply; then, with neither, a reply the latest turn to end finished that
 * `userId` has not caught up with.
 */
const threadActivities = Effect.fn("ChatView.threadActivities")(function* (
	userId: string,
	conversationIds: readonly string[],
) {
	const activities = new Map<string, ThreadActivity>();
	if (conversationIds.length === 0) return activities;
	const active = yield* query((db) => activeTurnsIn(db, conversationIds));
	const ended = yield* query((db) => latestEndedTurnsIn(db, userId, conversationIds));
	for (const turnEnded of ended) {
		if (turnEnded.status !== "done" || !turnEnded.replyUnread || !turnEnded.finishedAt) continue;
		activities.set(turnEnded.conversationId, {
			kind: "finished",
			at: turnEnded.finishedAt.toISOString(),
		});
	}
	for (const { conversationId, workingSince, waitingSince } of active) {
		if (waitingSince) {
			activities.set(conversationId, { kind: "waiting", since: waitingSince.toISOString() });
		} else if (workingSince) {
			activities.set(conversationId, { kind: "working", since: workingSince.toISOString() });
		}
	}
	return activities;
});

/**
 * For each of the conversations with a turn that has not ended: since when
 * its longest-waiting tool call has waited on an approval, and since when its
 * earliest turn waiting on none started. A turn whose approvals are all
 * decided but that has not resumed yet counts as working.
 */
const activeTurnsIn = Effect.fn("ChatView.activeTurnsIn")(function* (
	db: Executor,
	conversationIds: readonly string[],
) {
	return yield* db
		.select({
			conversationId: turn.conversationId,
			waitingSince: sql<Date | null>`min(${toolCall.startedAt})`.mapWith(toolCall.startedAt),
			workingSince:
				sql<Date | null>`min(${turn.startedAt}) filter (where ${toolCall.id} is null)`.mapWith(
					turn.startedAt,
				),
		})
		.from(turn)
		.leftJoin(toolCall, and(eq(toolCall.turnId, turn.id), eq(toolCall.approvalStatus, "pending")))
		.where(and(inArray(turn.conversationId, [...conversationIds]), Turns.isActive))
		.groupBy(turn.conversationId);
});

/**
 * The turn that ended last in each of the conversations, with how it ended
 * and whether its reply is one `userId` has not caught up with.
 */
const latestEndedTurnsIn = Effect.fn("ChatView.latestEndedTurnsIn")(function* (
	db: Executor,
	userId: string,
	conversationIds: readonly string[],
) {
	const unreadReply = db
		.select({ id: message.id })
		.from(message)
		.where(
			and(
				eq(message.turnId, turn.id),
				finishedWordsFromOthers(userId),
				unreadBy(db, userId, { conversationId: message.conversationId, at: message.createdAt }),
			),
		);
	return yield* db
		.selectDistinctOn([turn.conversationId], {
			conversationId: turn.conversationId,
			status: turn.status,
			finishedAt: turn.finishedAt,
			replyUnread: sql<boolean>`exists (${unreadReply})`,
		})
		.from(turn)
		.where(and(inArray(turn.conversationId, [...conversationIds]), isNotNull(turn.finishedAt)))
		.orderBy(turn.conversationId, desc(turn.finishedAt), desc(turn.id));
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
 * `@channel`. A bot's or an automation's notifies nobody, so it mentions
 * nobody.
 */
function mentions(handle: string): SQL {
	return sql`(${message.content} ~* ${mentionPattern(handle)} or (${message.authorUserId} is not null and ${message.content} ~* ${mentionPattern(...GROUP_MENTION_HANDLES)}))`;
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
	const { mentionsYou, unread, inConversation, listed } = inboxMessageTerms(db, input);
	const author = alias(bot, "author_bot");
	return yield* db
		.select({
			id: message.id,
			parts: message.parts,
			content: message.content,
			createdAt: message.createdAt,
			conversationId: placedConversation.id,
			place: {
				kind: placedConversation.kind,
				projectId: placedConversation.projectId,
				botId: placedConversation.botId,
			},
			authorUser: namedPersonColumns,
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
		.innerJoin(placedConversation, inConversation)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(author, eq(author.id, message.authorBotId))
		.where(and(listed, onlyUnreadMentions ? and(mentionsYou, unread) : or(mentionsYou, unread)))
		.orderBy(desc(message.createdAt))
		.limit(limit);
});

/**
 * How `inboxMessageRows` picks a message, over `message` joined to its
 * `placedConversation` by `inConversation`: `listed` holds for one in a
 * conversation Inbox shows, since `since`, written by somebody else;
 * `mentionsYou` and `unread` say how it stands for the person.
 */
function inboxMessageTerms(db: Executor, input: InboxScope) {
	return {
		mentionsYou: mentions(input.handle),
		unread: unreadBy(db, input.userId, {
			conversationId: message.conversationId,
			at: message.createdAt,
		}),
		inConversation: and(
			eq(placedConversation.id, message.conversationId),
			// The conversations whose messages notify people are the ones Inbox shows.
			eq(placedConversation.kind, "project_thread"),
		),
		listed: and(
			eq(placedConversation.workspaceId, input.workspaceId),
			input.reachesConversation(placedConversation),
			gt(message.createdAt, input.since),
			finishedWordsFromOthers(input.userId),
		),
	};
}

/**
 * How many of the messages Inbox would list are unread, and how many of
 * those mention the person.
 */
const inboxMessageCounts = Effect.fn("ChatView.inboxMessageCounts")(function* (
	db: Executor,
	input: InboxScope,
) {
	const { mentionsYou, unread, inConversation, listed } = inboxMessageTerms(db, input);
	const [counts] = yield* db
		.select({
			unread: sql<number>`count(*)::int`,
			unreadMentions: sql<number>`(count(*) filter (where ${mentionsYou}))::int`,
		})
		.from(message)
		.innerJoin(placedConversation, inConversation)
		.where(and(listed, unread));
	return counts ?? { unread: 0, unreadMentions: 0 };
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
		rootConversationId: row.conversationId,
		place: placeOf(row.place),
		at: row.createdAt.toISOString(),
		unread: row.unread,
	};
}

/** A message that mentions the person and that they have not read. */
export interface UnreadMention {
	messageId: string;
	authorName: string;
	/** The start of what it says. */
	preview: string;
	/** The conversation people open to read it. */
	rootConversationId: string;
}

/**
 * What the inbox looks through for `userId` in the workspace `workspaceId`,
 * which they are in and where `reachesConversation` is what they reach. Being
 * in the workspace means they have an account, as its members are removed
 * with their accounts.
 */
const inboxScopeIn = Effect.fn("ChatView.inboxScopeIn")(function* (
	reached: Pick<InboxScope, "workspaceId" | "userId" | "reachesConversation">,
) {
	const [person] = yield* query((db) =>
		db.select({ name: user.name }).from(user).where(eq(user.id, reached.userId)).limit(1),
	);
	if (!person) return yield* Effect.die(new Error("A workspace member has no account"));
	const since = DateTime.toDate(
		DateTime.subtract(yield* DateTime.now, { days: INBOX_WINDOW_DAYS }),
	);
	return { ...reached, handle: handleFromName(person.name), since } satisfies InboxScope;
});

/**
 * The conversations people open in the workspace `reached.workspaceId`, of
 * those `reached.reachesConversation` reaches, where `reached.userId` has
 * something unread: a message somebody else finished, or an automation run or
 * collaboration Inbox counts unread, by the conversation it is listed in.
 */
export const conversationsWithUnread = Effect.fn("ChatView.conversationsWithUnread")(function* (
	reached: Pick<InboxScope, "workspaceId" | "userId" | "reachesConversation">,
) {
	const withMessages = yield* query((db) =>
		db
			.selectDistinct({ id: placedConversation.id })
			.from(message)
			.innerJoin(placedConversation, eq(placedConversation.id, message.conversationId))
			.where(
				and(
					eq(placedConversation.workspaceId, reached.workspaceId),
					inArray(placedConversation.kind, [...OPENABLE_CONVERSATION_KINDS]),
					reached.reachesConversation(placedConversation),
					finishedWordsFromOthers(reached.userId),
					unreadBy(db, reached.userId, {
						conversationId: message.conversationId,
						at: message.createdAt,
					}),
				),
			),
	);
	const scope = yield* inboxScopeIn(reached);
	const withRuns = yield* query((db) => {
		const { conversation, unread, listed } = inboxRunTerms(db, scope);
		return db
			.selectDistinct({ id: conversation.id })
			.from(automationRun)
			.innerJoin(placedConversation, eq(placedConversation.id, automationRun.conversationId))
			.innerJoin(conversation, eq(conversation.id, placedConversation.rootConversationId))
			.where(and(listed, unread));
	});
	const withCollaborations = yield* query((db) => {
		const { asked, conversation, unread, listed } = inboxCollaborationTerms(db, scope);
		return db
			.selectDistinct({ id: conversation.id })
			.from(collaboration)
			.innerJoin(asked, eq(asked.id, collaboration.conversationId))
			.innerJoin(conversation, eq(conversation.id, asked.rootConversationId))
			.where(and(listed, unread));
	});
	return [...new Set([...withMessages, ...withRuns, ...withCollaborations].map(({ id }) => id))];
});

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
 * The projects `reachesProject` reaches, bots' default projects included,
 * with automations failing that `userId` has not opened since, and how many
 * each has.
 */
const failingAutomationsByProject = Effect.fn("ChatView.failingAutomationsByProject")(function* (
	db: Executor,
	workspaceId: string,
	reachesProject: Visibility.ReachesProject,
	userId: string,
) {
	const rows = yield* db
		.select({ projectId: automation.projectId, count: sql<number>`count(*)::int` })
		.from(automation)
		.where(
			and(
				eq(automation.workspaceId, workspaceId),
				isNull(automation.deletedAt),
				reachesProject(automation.projectId),
				unseenAutomationFailure(userId),
			),
		)
		.groupBy(automation.projectId);
	return new Map(rows.map((row) => [row.projectId, row.count] as const));
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
	const { conversation, unread, mentionsYou, listed } = inboxRunTerms(db, input);
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
			place: {
				kind: conversation.kind,
				projectId: conversation.projectId,
				botId: conversation.botId,
			},
			unread,
			mentionsYou,
			lastReply: lastReplyIn(db, automationRun.conversationId),
		})
		.from(automationRun)
		.innerJoin(placedConversation, eq(placedConversation.id, automationRun.conversationId))
		.innerJoin(conversation, eq(conversation.id, placedConversation.rootConversationId))
		.innerJoin(bot, eq(bot.id, automationRun.botId))
		.where(listed)
		.orderBy(desc(automationRun.acceptedAt))
		.limit(INBOX_ITEMS);
});

/** How many of the runs Inbox would list are unread, and how many of those mention the person. */
const inboxRunCounts = Effect.fn("ChatView.inboxRunCounts")(function* (
	db: Executor,
	input: InboxScope,
) {
	const { conversation, unread, mentionsYou, listed } = inboxRunTerms(db, input);
	const [counts] = yield* db
		.select({
			unread: sql<number>`count(*)::int`,
			unreadMentions: sql<number>`(count(*) filter (where ${mentionsYou}))::int`,
		})
		.from(automationRun)
		.innerJoin(placedConversation, eq(placedConversation.id, automationRun.conversationId))
		.innerJoin(conversation, eq(conversation.id, placedConversation.rootConversationId))
		.where(and(listed, unread));
	return counts ?? { unread: 0, unreadMentions: 0 };
});

/**
 * How `automationRunRows` picks a run, over `automationRun` joined to its own
 * `placedConversation` and that to `conversation`, the feed it is listed in:
 * `listed` holds for a run Inbox shows, and `unread` and `mentionsYou` say
 * how it stands for the person.
 */
function inboxRunTerms(db: Executor, input: InboxScope) {
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
	return {
		conversation,
		unread: sql<boolean>`(${isNews} and ${itemUnreadBy(db, input.userId, {
			conversationId: conversation.id,
			itemConversationId: automationRun.conversationId,
			at: sql`coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt})`,
		})})`,
		mentionsYou: sql<boolean>`exists (${resultMentioningYou})`,
		listed: and(
			eq(conversation.workspaceId, input.workspaceId),
			input.reachesConversation(conversation),
			gt(automationRun.acceptedAt, input.since),
			or(ne(automationRun.state, "completed"), posted),
		),
	};
}

/**
 * The collaborations one bot opened with another in the conversations
 * `userId` reaches since `since`, newest first, with both bots.
 */
const collaborationRows = Effect.fn("ChatView.collaborationRows")(function* (
	db: Executor,
	input: InboxScope,
) {
	const { asked, conversation, unread, listed } = inboxCollaborationTerms(db, input);
	const askingMessage = alias(message, "asking_message");
	const initiator = alias(bot, "initiator");
	const recipient = alias(bot, "recipient");
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
			place: {
				kind: conversation.kind,
				projectId: conversation.projectId,
				botId: conversation.botId,
			},
			unread,
		})
		.from(collaboration)
		.innerJoin(asked, eq(asked.id, collaboration.conversationId))
		.innerJoin(conversation, eq(conversation.id, asked.rootConversationId))
		.innerJoin(askingMessage, eq(askingMessage.id, collaboration.parentMessageId))
		.innerJoin(initiator, eq(initiator.id, askingMessage.authorBotId))
		.innerJoin(recipient, eq(recipient.id, collaboration.collaboratorBotId))
		.where(listed)
		.orderBy(desc(collaboration.createdAt))
		.limit(INBOX_ITEMS);
});

/** How many of the collaborations Inbox would list are unread. */
const inboxCollaborationsUnread = Effect.fn("ChatView.inboxCollaborationsUnread")(function* (
	db: Executor,
	input: InboxScope,
) {
	const { asked, conversation, unread, listed } = inboxCollaborationTerms(db, input);
	const [counted] = yield* db
		.select({ unread: sql<number>`count(*)::int` })
		.from(collaboration)
		.innerJoin(asked, eq(asked.id, collaboration.conversationId))
		.innerJoin(conversation, eq(conversation.id, asked.rootConversationId))
		.where(and(listed, unread));
	return counted?.unread ?? 0;
});

/**
 * How `collaborationRows` picks a collaboration, over `collaboration` joined
 * to its own conversation, `asked`, and that to `conversation`, the one it
 * hangs under: `listed` holds for one Inbox shows, and `unread` says whether
 * the person has caught up with it.
 */
function inboxCollaborationTerms(db: Executor, input: InboxScope) {
	const asked = alias(placedConversation, "asked_conversation");
	const conversation = alias(placedConversation, "conversation");
	return {
		asked,
		conversation,
		unread: itemUnreadBy(db, input.userId, {
			conversationId: conversation.id,
			itemConversationId: collaboration.conversationId,
			at: collaboration.createdAt,
		}),
		listed: and(
			eq(conversation.workspaceId, input.workspaceId),
			input.reachesConversation(conversation),
			gt(collaboration.createdAt, input.since),
		),
	};
}

/** How many answered approvals the inbox lists, newest first. */
const ANSWERED_APPROVALS = 50;
/** At most this many waiting approvals are listed; more than this many waiting is a backlog to clear in its conversations. */
const WAITING_APPROVALS = 100;

/**
 * Which approvals `userId` may decide in the conversations they reach, by
 * `mayDecideToolCall`, the rule deciding an approval checks: by their
 * standing in the project of the conversation a call's conversation belongs
 * to, and, for a request to change a computer, in the computer's project.
 * That project need not be one they reach: an administrator decides a private
 * bot's computer requests, raised in a collaboration they can see, without
 * reaching the bot's threads.
 */
const approvalDecidersIn = Effect.fn("ChatView.approvalDecidersIn")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const projects = new Map(
		(yield* projectStandingsFor(db, workspaceId, userId)).map((standing) => [
			standing.project.id,
			standing,
		]),
	);
	const unreachedComputerProjectIds = (yield* waitingComputerRequestProjectIds(
		db,
		workspaceId,
	)).filter((id) => !projects.has(id));
	const computerProjects = new Map(projects);
	for (const standing of yield* projectStandingsOf(db, unreachedComputerProjectIds, userId)) {
		computerProjects.set(standing.project.id, standing);
	}
	/**
	 * `projectId` is the project of the conversation the call's conversation
	 * belongs to; `computerProjectId` the project whose computer the asking
	 * turn worked on.
	 */
	const mayDecide = (
		projectId: string | null,
		computerProjectId: string | null,
		inAutomation: boolean,
		deciders: ToolApprovalDeciders,
	) => {
		const standing = projectId === null ? undefined : projects.get(projectId);
		return mayDecideToolCall(
			standing,
			computerProjectId === null ? undefined : computerProjects.get(computerProjectId),
			inAutomation,
			deciders,
		);
	};
	const projectIds = [...projects.keys()];
	const decidable: Decidable = {
		outsideAutomations: projectIds.filter((id) => mayDecide(id, null, false, "conversation")),
		inAutomations: projectIds.filter((id) => mayDecide(id, null, true, "conversation")),
		computerRequests: [...computerProjects.keys()].filter((id) =>
			mayDecide(null, id, false, "computer-managers"),
		),
	};
	return { mayDecide, decidable };
});

/** The projects whose computers a waiting request to change a computer in the workspace is for. */
const waitingComputerRequestProjectIds = Effect.fn("ChatView.waitingComputerRequestProjectIds")(
	function* (db: Executor, workspaceId: string) {
		const asking = alias(placedConversation, "asking_conversation");
		const rows = yield* db
			.selectDistinct({ projectId: computerProjectIdOf(asking, turn.botId) })
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.conversationId))
			.innerJoin(turn, eq(turn.id, toolCall.turnId))
			.where(
				and(
					eq(asking.workspaceId, workspaceId),
					eq(toolCall.approvalStatus, "pending"),
					inArray(toolCall.tool, [...COMPUTER_REQUEST_TOOLS]),
				),
			);
		return rows.flatMap(({ projectId }) => (projectId ? [projectId] : []));
	},
);

/**
 * Where a person may decide approvals, by project: the projects whose
 * conversations' approvals they decide, those raised while an automation runs
 * apart, and the projects whose computer's requests they decide (see
 * `decidersOf`).
 */
interface Decidable {
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
	const waiting = waitingOnDecision(decidable, asking, conversation, reachesConversation);
	if (!waiting) return [];
	return yield* selectApprovals(db, asking, conversation)
		.where(waiting)
		.orderBy(asc(toolCall.startedAt))
		.limit(WAITING_APPROVALS);
});

/** How many approvals wait on a decision `decidable` allows, every one of them rather than a page. */
const waitingApprovalCount = Effect.fn("ChatView.waitingApprovalCount")(function* (
	db: Executor,
	decidable: Decidable,
	reachesConversation: Visibility.ReachesConversation,
) {
	const asking = alias(placedConversation, "asking_conversation");
	const conversation = alias(placedConversation, "approval_conversation");
	const waiting = waitingOnDecision(decidable, asking, conversation, reachesConversation);
	if (!waiting) return 0;
	const [counted] = yield* db
		.select({ waiting: sql<number>`count(*)::int` })
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.conversationId))
		.innerJoin(conversation, eq(conversation.id, asking.rootConversationId))
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.where(waiting);
	return counted?.waiting ?? 0;
});

/**
 * Whether a tool call, joined to the conversation it asks in, `asking`, the
 * conversation that belongs to, `conversation`, and its turn, waits on a
 * decision `decidable` allows in a conversation `reachesConversation`
 * reaches. Undefined when `decidable` allows none.
 */
function waitingOnDecision(
	decidable: Decidable,
	asking: AskingConversation,
	conversation: ApprovalConversation,
	reachesConversation: Visibility.ReachesConversation,
): SQL | undefined {
	const computerRequest = inArray(toolCall.tool, [...COMPUTER_REQUEST_TOOLS]);
	const inAutomation = isNotNull(runIdOf(asking.id));
	const conditions: SQL[] = [];
	if (decidable.outsideAutomations.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and ${inArray(conversation.projectId, [...decidable.outsideAutomations])} and not ${inAutomation}`,
		);
	}
	if (decidable.inAutomations.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and ${inArray(conversation.projectId, [...decidable.inAutomations])} and ${inAutomation}`,
		);
	}
	if (decidable.computerRequests.length > 0) {
		conditions.push(
			sql`${computerRequest} and ${computerProjectIdOf(asking, turn.botId)} in (${sql.join(
				decidable.computerRequests.map((id) => sql`${id}::uuid`),
				sql`, `,
			)})`,
		);
	}
	if (conditions.length === 0) return undefined;
	return and(
		eq(toolCall.approvalStatus, "pending"),
		or(...conditions),
		reachesConversation(asking),
	);
}

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
			// A collaboration's is the project of the conversation it was opened from.
			projectId: listedProjectIdOf(conversation),
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
		projectId: row.projectId,
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
				projectId: conversation.projectId,
				computerProjectId: computerProjectIdOf(asking, turn.botId),
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
			pending.flatMap(({ rootConversationId, projectId, computerProjectId, runId, tool }) =>
				rootConversationId &&
				mayDecide(projectId, computerProjectId, runId !== null, decidersOf(tool))
					? [rootConversationId]
					: [],
			),
		);
	},
);

/**
 * The project a conversation is listed under, as `placedConversation` or an
 * alias of it reads: a project people made. A bot's thread, in its default
 * project, is listed under the bot, so it has none.
 */
function listedProjectIdOf(row: { projectId: SQLWrapper; botId: SQLWrapper }): SQL<string | null> {
	return sql<string | null>`case when ${row.botId} is null then ${row.projectId} end`;
}

/**
 * Where a conversation people open is, from its kind, project and bot: a
 * bot's default project is listed under the bot.
 */
function placeOf(row: {
	kind: ConversationKind;
	projectId: string | null;
	botId: string | null;
}): ConversationPlace {
	if (row.botId !== null) return { kind: "bot", botId: row.botId };
	if (row.projectId !== null) return { kind: "project", projectId: row.projectId };
	// Only a system bot's conversation is in neither, and it is never one people open.
	throw new Error(`The ${row.kind} conversation people open is in no project`);
}

/** A thread as a list sorts it: by its newest message, or by when it began. */
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
						}
					: null,
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

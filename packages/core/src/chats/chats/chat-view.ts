export * as ChatView from "./chat-view.ts";

import type {
	AnsweredApproval,
	ApprovalRequest,
	AttentionCounts,
	AttentionMark,
	AttentionMarks,
	ChatHistoryEntry,
	ChatHistoryPage,
	ChatMessageItem,
	ChatMessagesPage,
	ChatPageQuery,
	ChatStatus,
	ListedChat,
	ProjectChatList,
	ToolApprovers,
	WorkspaceApprovals,
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
	notInArray,
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
import type { BotFacts } from "../../authorization/permissions.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import type { relations } from "../../database/relations.ts";
import type * as schema from "../../database/schema.ts";
import {
	automation,
	automationFeed,
	automationRun,
	bot,
	chatRead,
	message,
	OPENABLE_CHAT_KINDS,
	person,
	placedChat,
	project,
	toolCall,
	turn,
} from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import {
	latestRunOf,
	listStatusColumns,
	resultPosted,
	runBotFactsOf,
	runBotIdOf,
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
} from "../store/participants.ts";
import { toToolCallPart } from "../store/tool-calls.ts";
import { approversOf, COMPUTER_REQUEST_TOOLS } from "../tools/approvers.ts";
import { Turns } from "../turns/turns.ts";
import { toAutomationFeed, toProjectChat } from "./chat.ts";

/**
 * What the chat screens show, of the chats the current actor can see:
 * a project's chats (a bot's are its default project's), and a
 * chat's two timelines.
 */
export interface Interface {
	/**
	 * The chats and automations of the project `projectId`, a bot's default
	 * project included. Hidden unless the actor reaches it.
	 */
	readonly chats: (
		projectId: string,
	) => Effect.Effect<ProjectChatList, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How each project of the workspace the actor reaches, bots' default
	 * projects included, stands for them: its chats' and automation feeds'
	 * unread messages, whether any waits on their decision, and how many of its
	 * automations are failing unseen.
	 */
	readonly attentionMarks: (
		workspace: string,
	) => Effect.Effect<AttentionMarks, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The approvals across the workspace for the actor: those waiting on a
	 * decision they may make, and the latest answered by the bots they reach.
	 */
	readonly approvals: (
		workspace: string,
	) => Effect.Effect<WorkspaceApprovals, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * How much in the workspace waits for the actor: approvals they may
	 * decide, and unread messages and automation results that mention them,
	 * over the last `ATTENTION_WINDOW_DAYS`.
	 */
	readonly attention: (
		workspace: string,
	) => Effect.Effect<AttentionCounts, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The newest `limit` messages in the workspace's chats, over the last
	 * `ATTENTION_WINDOW_DAYS`, that mention the actor and they have not read.
	 */
	readonly unreadMentions: (
		workspace: string,
		limit: number,
	) => Effect.Effect<UnreadMention[], AuthorizationDenied, CurrentActor.Service>;
	/** A page of the chat, newest last. */
	readonly messages: (
		chatId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatMessagesPage, ResourceHidden | InvalidPageCursor, CurrentActor.Service>;
	/** A page of the chats opened beside the chat, newest activity first. */
	readonly history: (
		chatId: string,
		page?: ChatPageQuery,
	) => Effect.Effect<ChatHistoryPage, ResourceHidden | InvalidPageCursor, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatView");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;

	/** How each of the chats stands for the actor: its unread messages, and waiting on their decision. */
	const chatMarks = Effect.fn("ChatView.chatMarks")(function* (
		workspaceId: string,
		chatIds: readonly string[],
	) {
		const { personId } = yield* CurrentActor.Service;
		const unread = yield* query((db) => unreadMessageCounts(db, personId, chatIds));
		const awaiting = yield* query((db) =>
			chatsAwaitingDecisionBy(db, { workspaceId, personId, chatIds }),
		);
		return (chatId: string) => ({
			unreadMessages: unread.get(chatId) ?? 0,
			needsApproval: awaiting.has(chatId),
		});
	});

	/**
	 * The chats `rows` as a project's list shows them to `personId`: each with
	 * its latest message, how many it holds, who has written in it lately,
	 * and how it stands for them, newest message first.
	 */
	const listedChats = Effect.fn("ChatView.listedChats")(function* (
		workspaceId: string,
		personId: string,
		rows: readonly ProjectChatRow[],
	) {
		const chatIds = rows.map((row) => row.chat.id);
		const latest = yield* query((db) => latestMessages(db, chatIds));
		const counts = yield* query((db) => messageCounts(db, chatIds));
		const marksOf = yield* chatMarks(workspaceId, chatIds);
		const mentioning = yield* query((db) => unreadMentionsIn(db, personId, chatIds));
		const statuses = yield* chatStatuses(personId, chatIds);
		const listed = rows.map((row): ListedChat => {
			const last = latest.get(row.chat.id);
			return {
				chat: toProjectChat(row.chat),
				lastMessage: last
					? {
							preview: replyPreview(last),
							authorPersonId: last.authorPersonId,
							at: last.createdAt.toISOString(),
						}
					: null,
				participants: row.participants.map(toParticipant),
				messageCount: counts.get(row.chat.id) ?? 0,
				...marksOf(row.chat.id),
				mentionsYou: mentioning.has(row.chat.id),
				status: statuses.get(row.chat.id) ?? null,
			};
		});
		return listed.sort(byLatestMessage);
	});

	return Service.of({
		chats: (projectId) =>
			operation(
				"chats",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("chat.list.project", projectId);
					const standing = yield* authorization.project(projectId, "project.read");
					const { project: listed, actor } = standing;
					const { personId } = actor;
					const rows = yield* query((db) => projectChats(db, listed.id));
					const chats = yield* listedChats(listed.workspaceId, personId, rows);
					const owned = yield* query((db) => listedAutomations(db, listed.id));
					const feedMentions = yield* query((db) =>
						unreadMentionsIn(
							db,
							personId,
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
						chat: row.feed && toAutomationFeed(row.feed),
						mentionsYou: row.feed !== null && feedMentions.has(row.feed.id),
						status: toListStatus(row),
					}));
					return { chats, automations };
				}),
			),

		attentionMarks: (workspace) =>
			operation(
				"attentionMarks",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { personId } = yield* CurrentActor.Service;
					const reachesProject = yield* visibility.reachesProject;
					const chats = yield* query((db) => projectChatsReached(db, workspaceId, reachesProject));
					const marksOf = yield* chatMarks(
						workspaceId,
						chats.map(({ id }) => id),
					);
					const failed = yield* query((db) =>
						failingAutomationsByProject(db, workspaceId, reachesProject, personId),
					);
					const projects: Record<string, AttentionMark> = {};
					for (const { id, projectId } of chats) {
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
					const { personId } = yield* CurrentActor.Service;
					const approvers = yield* query((db) => approversIn(db, workspaceId, personId));
					const reachesChat = yield* visibility.reachesChat;
					const waiting = yield* query((db) =>
						waitingApprovalRows(db, approvers.decidable, reachesChat),
					);
					const answered = yield* query((db) => answeredApprovalRows(db, workspaceId, reachesChat));
					return {
						waiting: waiting.map(toApprovalRequest),
						answered: answered.flatMap((row): AnsweredApproval[] => {
							const answer = answerOf(row);
							return answer ? [{ ...toApprovalRequest(row), answer }] : [];
						}),
					};
				}),
			),

		attention: (workspace) =>
			operation(
				"attention",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { personId } = yield* CurrentActor.Service;
					const approvers = yield* query((db) => approversIn(db, workspaceId, personId));
					const reachesChat = yield* visibility.reachesChat;
					const waitingApprovals = yield* query((db) =>
						waitingApprovalCount(db, approvers.decidable, reachesChat),
					);
					const scope = yield* attentionScopeIn({ workspaceId, personId, reachesChat });
					const messages = yield* query((db) => unreadMentionCount(db, scope));
					const runs = yield* query((db) => unreadRunMentionCount(db, scope));
					return { waitingApprovals, unreadForYou: messages + runs };
				}),
			),

		unreadMentions: (workspace, limit) =>
			operation(
				"unreadMentions",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const { personId } = yield* CurrentActor.Service;
					const scope = yield* attentionScopeIn({
						workspaceId,
						personId,
						reachesChat: yield* visibility.reachesChat,
					});
					const messages = yield* query((db) => unreadMentionRows(db, scope, limit));
					return messages.map(
						(row): UnreadMention => ({
							messageId: row.id,
							authorName: toParticipant(authorRow(row.authorPerson, row.authorBot)).name,
							preview: replyPreview(row),
							chatId: row.chatId,
							projectSlug: row.defaultOfBotId === null ? row.projectSlug : null,
						}),
					);
				}),
			),

		messages: (chatId, page = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			operation(
				"messages",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					if (!isUuid(chatId)) {
						return yield* new ResourceHidden({ resource: "chat" });
					}
					// Before the query, and whether or not the chat is there, so a
					// bad cursor says nothing about the chat.
					const before = page.cursor ? yield* pageCursor(page.cursor) : undefined;
					const reachesChat = yield* visibility.reachesChat;
					const row = yield* query((db) =>
						loadMainPage(db, chatId, reachesChat, page.limit, before),
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
					if (!isUuid(chatId)) {
						return yield* new ResourceHidden({ resource: "chat" });
					}
					const before = page.cursor ? yield* pageCursor(page.cursor) : undefined;
					const reachesChat = yield* visibility.reachesChat;
					const row = yield* query((db) =>
						loadHistory(db, chatId, reachesChat, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return toHistoryPage(row, page.limit);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

/** A project's attention mark before any of its chats or automations is counted. */
const NOTHING_NEW: AttentionMark = {
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
 * with its chat when it has one, its latest run and whether it is
 * failing.
 */
const listedAutomations = Effect.fn("ChatView.listedAutomations")(function* (
	db: Executor,
	projectId: string,
) {
	const feed = alias(placedChat, "feed");
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

/** One of the chats a list shows, with who has written in it lately. */
type ProjectChatRow = Effect.Success<ReturnType<typeof projectChats>>[number];

/**
 * The project's chats, resolved ones among them, most recently changed first, each with
 * who has written in it lately.
 */
const projectChats = Effect.fn("ChatView.projectChats")(function* (
	db: Executor,
	projectId: string,
) {
	return yield* db
		.select({
			chat: getColumns(placedChat),
			participants: recentParticipantsOf(placedChat.id),
		})
		.from(placedChat)
		.where(and(eq(placedChat.kind, "project_chat"), eq(placedChat.projectId, projectId)))
		.orderBy(desc(placedChat.updatedAt), desc(placedChat.id));
});

/**
 * The chats and the automation feeds of every project in the
 * workspace that `reachesProject` reaches, bots' default projects included.
 */
const projectChatsReached = Effect.fn("ChatView.projectChatsReached")(function* (
	db: Executor,
	workspaceId: string,
	reachesProject: Visibility.ReachesProject,
) {
	const rows = yield* db
		.select({ id: placedChat.id, projectId: placedChat.projectId })
		.from(placedChat)
		.where(
			and(
				inArray(placedChat.kind, ["project_chat", "automation_feed"]),
				eq(placedChat.workspaceId, workspaceId),
				reachesProject(placedChat.projectId),
			),
		);
	return rows.flatMap(({ id, projectId }) => (projectId ? [{ id, projectId }] : []));
});

/** How many messages each of the chats holds, by its id; one with none is left out. */
const messageCounts = Effect.fn("ChatView.messageCounts")(function* (
	db: Executor,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Map<string, number>();
	const rows = yield* db
		.select({ chatId: message.chatId, count: count() })
		.from(message)
		.where(inArray(message.chatId, [...chatIds]))
		.groupBy(message.chatId);
	return new Map(rows.map((row) => [row.chatId, row.count]));
});

/** The newest message with words in it in each chat, in one query. */
const latestMessages = Effect.fn("ChatView.latestMessages")(function* (
	db: Executor,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) {
		return new Map<
			string,
			{
				content: string;
				parts: schema.StoredMessagePart[];
				authorPersonId: string | null;
				createdAt: Date;
			}
		>();
	}
	const rows = yield* db
		.selectDistinctOn([message.chatId], {
			chatId: message.chatId,
			content: message.content,
			parts: message.parts,
			authorPersonId: message.authorPersonId,
			createdAt: message.createdAt,
		})
		.from(message)
		.where(and(inArray(message.chatId, [...chatIds]), ne(message.content, "")))
		.orderBy(message.chatId, desc(message.createdAt));
	return new Map(rows.map((row) => [row.chatId, row]));
});

/**
 * How many messages with words in them somebody other than `personId` finished on
 * each of the chats since `personId` caught up with it, by `caughtUpAt`.
 * Chats with none are left out.
 */
const unreadMessageCounts = Effect.fn("ChatView.unreadMessageCounts")(function* (
	db: Executor,
	personId: string,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Map<string, number>();
	const rows = yield* db
		.select({ chatId: message.chatId, count: sql<number>`count(*)::int` })
		.from(message)
		.where(
			and(
				inArray(message.chatId, [...chatIds]),
				finishedWordsFromOthers(personId),
				unreadBy(db, personId, { chatId: message.chatId, at: message.createdAt }),
			),
		)
		.groupBy(message.chatId);
	return new Map(rows.map((row) => [row.chatId, row.count]));
});

/** Those of the chats with a message `personId` has not read that mentions them. */
const unreadMentionsIn = Effect.fn("ChatView.unreadMentionsIn")(function* (
	db: Executor,
	personId: string,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Set<string>();
	const [somebody] = yield* db
		.select({ name: person.name })
		.from(person)
		.where(eq(person.id, personId))
		.limit(1);
	if (!somebody) return new Set<string>();
	const rows = yield* db
		.selectDistinct({ chatId: message.chatId })
		.from(message)
		.where(
			and(
				inArray(message.chatId, [...chatIds]),
				finishedWordsFromOthers(personId),
				mentions(handleFromName(somebody.name)),
				unreadBy(db, personId, { chatId: message.chatId, at: message.createdAt }),
			),
		);
	return new Set(rows.map((row) => row.chatId));
});

/**
 * What the bots are doing in each of the chats, as `personId`'s list
 * shows it, by its id; one with nothing to show is left out. A turn waiting on
 * an approval comes first, as it waits on a person; then a turn working on a
 * reply; then, with neither, a reply the latest turn to end finished that
 * `personId` has not caught up with.
 */
const chatStatuses = Effect.fn("ChatView.chatStatuses")(function* (
	personId: string,
	chatIds: readonly string[],
) {
	const statuses = new Map<string, ChatStatus>();
	if (chatIds.length === 0) return statuses;
	const active = yield* query((db) => activeTurnsIn(db, chatIds));
	const ended = yield* query((db) => latestEndedTurnsIn(db, personId, chatIds));
	for (const turnEnded of ended) {
		if (turnEnded.status !== "done" || !turnEnded.replyUnread || !turnEnded.finishedAt) continue;
		statuses.set(turnEnded.chatId, {
			kind: "replied",
			at: turnEnded.finishedAt.toISOString(),
		});
	}
	for (const { chatId, workingSince, waitingSince } of active) {
		if (waitingSince) {
			statuses.set(chatId, { kind: "waiting", since: waitingSince.toISOString() });
		} else if (workingSince) {
			statuses.set(chatId, { kind: "working", since: workingSince.toISOString() });
		}
	}
	return statuses;
});

/**
 * For each of the chats with a turn that has not ended: since when
 * its longest-waiting tool call has waited on an approval, and since when its
 * earliest turn waiting on none started. A turn whose approvals are all
 * decided but that has not resumed yet counts as working.
 */
const activeTurnsIn = Effect.fn("ChatView.activeTurnsIn")(function* (
	db: Executor,
	chatIds: readonly string[],
) {
	return yield* db
		.select({
			chatId: turn.chatId,
			waitingSince: sql<Date | null>`min(${toolCall.startedAt})`.mapWith(toolCall.startedAt),
			workingSince:
				sql<Date | null>`min(${turn.startedAt}) filter (where ${toolCall.id} is null)`.mapWith(
					turn.startedAt,
				),
		})
		.from(turn)
		.leftJoin(toolCall, and(eq(toolCall.turnId, turn.id), eq(toolCall.approvalStatus, "pending")))
		.where(and(inArray(turn.chatId, [...chatIds]), Turns.isActive))
		.groupBy(turn.chatId);
});

/**
 * The turn that ended last in each of the chats, with how it ended
 * and whether its reply is one `personId` has not caught up with.
 */
const latestEndedTurnsIn = Effect.fn("ChatView.latestEndedTurnsIn")(function* (
	db: Executor,
	personId: string,
	chatIds: readonly string[],
) {
	const unreadReply = db
		.select({ id: message.id })
		.from(message)
		.where(
			and(
				eq(message.turnId, turn.id),
				finishedWordsFromOthers(personId),
				unreadBy(db, personId, { chatId: message.chatId, at: message.createdAt }),
			),
		);
	return yield* db
		.selectDistinctOn([turn.chatId], {
			chatId: turn.chatId,
			status: turn.status,
			finishedAt: turn.finishedAt,
			replyUnread: sql<boolean>`exists (${unreadReply})`,
		})
		.from(turn)
		.where(and(inArray(turn.chatId, [...chatIds]), isNotNull(turn.finishedAt)))
		.orderBy(turn.chatId, desc(turn.finishedAt), desc(turn.id));
});

/** A `message` with words in it, finished, written by somebody other than `personId`. */
function finishedWordsFromOthers(personId: string): SQL | undefined {
	return and(
		ne(message.content, ""),
		ne(message.status, "writing"),
		sql`${message.authorPersonId} is distinct from ${personId}`,
	);
}

/**
 * Whether `personId` has yet to catch up with something that happened in
 * `chatId` at `at`, by `caughtUpAt`.
 */
function unreadBy(
	db: Executor,
	personId: string,
	{ chatId, at }: { chatId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`coalesce(${at} > ${caughtUpAt(db, personId, chatId)}, true)`;
}

/**
 * Whether `personId` has yet to catch up with an automation run that ended
 * at `at`: neither the chat it is listed in, `chatId`, nor its own chat,
 * `nestedChatId`, read past then. Opening the run as a page of its own reads
 * its own chat, so it reads that run alone.
 */
function nestedChatUnreadBy(
	db: Executor,
	personId: string,
	{ chatId, nestedChatId, at }: { chatId: SQLWrapper; nestedChatId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`(${unreadBy(db, personId, { chatId, at })} and ${unreadBy(db, personId, { chatId: nestedChatId, at })})`;
}

/**
 * When `personId` last caught up with `chatId`: the later of how far they
 * have read it and the last message they wrote there, or null when neither.
 *
 * A reply is stamped when it began. Reading never moves past a reply still
 * being written, so one the person read around still counts once it is done.
 * Writing does: a reply that began before the person's last message counts
 * as caught up with, even if it finished after, because a message does not
 * keep when it finished.
 */
function caughtUpAt(db: Executor, personId: string, chatId: SQLWrapper): SQL<Date | null> {
	const own = alias(message, "own_message");
	// Through `sql`, because a timestamp column selected bare is cast to text for reading.
	const readThrough = db
		.select({ at: sql`${chatRead.readThrough}` })
		.from(chatRead)
		.where(and(sql`${chatRead.chatId} = ${chatId}`, eq(chatRead.personId, personId)));
	const lastWritten = db
		.select({ at: sql`max(${own.createdAt})` })
		.from(own)
		.where(and(sql`${own.chatId} = ${chatId}`, eq(own.authorPersonId, personId)));
	return sql<Date | null>`greatest((${readThrough}), (${lastWritten}))`;
}

/**
 * Whether a `message` mentions `handle`, or is a person's `@here` or
 * `@channel`. A bot's or an automation's notifies nobody, so it mentions
 * nobody.
 */
function mentions(handle: string): SQL {
	return sql`(${message.content} ~* ${mentionPattern(handle)} or (${message.authorPersonId} is not null and ${message.content} ~* ${mentionPattern(...GROUP_MENTION_HANDLES)}))`;
}

/** How far back what waits for a person goes: past this, a message is old news, read or not. */
const ATTENTION_WINDOW_DAYS = 30;

/**
 * The newest `limit` messages in the project chats `input.personId` reaches,
 * since `input.since`, written by somebody else, that mention them and they
 * have not read, with their authors and where each opens.
 */
const unreadMentionRows = Effect.fn("ChatView.unreadMentionRows")(function* (
	db: Executor,
	input: AttentionScope,
	limit: number,
) {
	const author = alias(bot, "author_bot");
	return yield* db
		.select({
			id: message.id,
			parts: message.parts,
			content: message.content,
			createdAt: message.createdAt,
			chatId: placedChat.id,
			projectSlug: project.slug,
			defaultOfBotId: project.defaultOfBotId,
			authorPerson: namedPersonColumns,
			authorBot: {
				id: author.id,
				name: author.name,
				handle: author.handle,
				color: author.color,
				eyes: author.eyes,
				shape: author.shape,
			},
		})
		.from(message)
		.innerJoin(placedChat, inProjectChat)
		.innerJoin(project, eq(project.id, placedChat.projectId))
		.leftJoin(person, eq(person.id, message.authorPersonId))
		.leftJoin(author, eq(author.id, message.authorBotId))
		.where(unreadMentionOf(db, input))
		.orderBy(desc(message.createdAt))
		.limit(limit);
});

/** How many messages `unreadMentionRows` would find, with no limit. */
const unreadMentionCount = Effect.fn("ChatView.unreadMentionCount")(function* (
	db: Executor,
	input: AttentionScope,
) {
	const [counted] = yield* db
		.select({ count: sql<number>`count(*)::int` })
		.from(message)
		.innerJoin(placedChat, inProjectChat)
		.where(unreadMentionOf(db, input));
	return counted?.count ?? 0;
});

/**
 * Joins `message` to its `placedChat` when that is a project's chat: the
 * chats whose messages notify people.
 */
const inProjectChat = and(eq(placedChat.id, message.chatId), eq(placedChat.kind, "project_chat"));

/**
 * Whether a `message`, joined to its `placedChat` by `inProjectChat`, is in
 * the workspace and reached, since `input.since`, finished by somebody else,
 * mentions the person and is unread by them.
 */
function unreadMentionOf(db: Executor, input: AttentionScope) {
	return and(
		eq(placedChat.workspaceId, input.workspaceId),
		input.reachesChat(placedChat),
		gt(message.createdAt, input.since),
		finishedWordsFromOthers(input.personId),
		mentions(input.handle),
		unreadBy(db, input.personId, { chatId: message.chatId, at: message.createdAt }),
	);
}

/** A message that mentions the person and that they have not read. */
export interface UnreadMention {
	messageId: string;
	authorName: string;
	/** The start of what it says. */
	preview: string;
	/** The chat it was written in. */
	chatId: string;
	/** The project people made that the chat is in; null in a bot's chat. */
	projectSlug: string | null;
}

/**
 * What is looked through for `personId` in the workspace `workspaceId`, which
 * they are in and where `reachesChat` is what they reach. Being in the
 * workspace means they have an account, as their memberships are removed
 * with their accounts.
 */
const attentionScopeIn = Effect.fn("ChatView.attentionScopeIn")(function* (
	reached: Pick<AttentionScope, "workspaceId" | "personId" | "reachesChat">,
) {
	const [somebody] = yield* query((db) =>
		db.select({ name: person.name }).from(person).where(eq(person.id, reached.personId)).limit(1),
	);
	if (!somebody) return yield* Effect.die(new Error("A person in the workspace has no account"));
	const since = DateTime.toDate(
		DateTime.subtract(yield* DateTime.now, { days: ATTENTION_WINDOW_DAYS }),
	);
	return { ...reached, handle: handleFromName(somebody.name), since } satisfies AttentionScope;
});

interface AttentionScope {
	workspaceId: string;
	reachesChat: Visibility.ReachesChat;
	personId: string;
	/** The person's handle, which mentions of them use. */
	handle: string;
	since: Date;
}

/** The newest finished reply with words in it a bot wrote in `chatId`, or null when it has written none. */
function lastReplyIn(db: Executor, chatId: SQLWrapper): SQL<Reply | null> {
	const reply = alias(message, "last_reply");
	const latest = db
		.select({ reply: sql`json_build_object('content', ${reply.content}, 'parts', ${reply.parts})` })
		.from(reply)
		.where(
			and(
				sql`${reply.chatId} = ${chatId}`,
				sql`${reply.authorBotId} is not null`,
				ne(reply.content, ""),
				ne(reply.status, "writing"),
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

/** What `reply` says as a chat shows it, without the narration before its tool calls. */
function spokenText(reply: Reply): string {
	return textWithoutNarration(reply.parts) || reply.content;
}

/**
 * The projects `reachesProject` reaches, bots' default projects included,
 * with automations failing that `personId` has not opened since, and how many
 * each has.
 */
const failingAutomationsByProject = Effect.fn("ChatView.failingAutomationsByProject")(function* (
	db: Executor,
	workspaceId: string,
	reachesProject: Visibility.ReachesProject,
	personId: string,
) {
	const rows = yield* db
		.select({ projectId: automation.projectId, count: sql<number>`count(*)::int` })
		.from(automation)
		.where(
			and(
				eq(automation.workspaceId, workspaceId),
				isNull(automation.deletedAt),
				reachesProject(automation.projectId),
				unseenAutomationFailure(personId),
			),
		)
		.groupBy(automation.projectId);
	return new Map(rows.map((row) => [row.projectId, row.count] as const));
});

/**
 * How many automation runs in the feeds the person reaches, since
 * `input.since`, posted a result that mentions them and they have not read.
 */
const unreadRunMentionCount = Effect.fn("ChatView.unreadRunMentionCount")(function* (
	db: Executor,
	input: AttentionScope,
) {
	const { feed, unread, mentionsYou, listed } = runAttentionTerms(db, input);
	const [counted] = yield* db
		.select({ count: sql<number>`count(*)::int` })
		.from(automationRun)
		.innerJoin(placedChat, eq(placedChat.id, automationRun.chatId))
		.innerJoin(feed, eq(feed.id, placedChat.rootChatId))
		.where(and(listed, unread, mentionsYou));
	return counted?.count ?? 0;
});

/**
 * How `unreadRunMentionCount` picks a run, over `automationRun` joined to its
 * own `placedChat` and that to `feed`, the automation's feed it is listed in:
 * `listed` holds for a run since `input.since` that did not complete with
 * nothing to report, and `unread` and `mentionsYou` say how it stands for the
 * person. A run is unread only once it posted a result or failed, from when
 * it ended. It mentions the person when its result, posted only in the
 * automation's feed, does.
 */
function runAttentionTerms(db: Executor, input: AttentionScope) {
	const feed = alias(placedChat, "feed");
	const posted = resultPosted(automationRun.id);
	const elsewhere = alias(message, "result_elsewhere");
	const resultMentioningYou = db
		.select({ id: message.id })
		.from(message)
		.where(
			and(
				eq(message.runId, automationRun.id),
				eq(message.chatId, feed.id),
				mentions(input.handle),
				sql`not exists (${db
					.select({ id: elsewhere.id })
					.from(elsewhere)
					.where(and(eq(elsewhere.runId, automationRun.id), ne(elsewhere.chatId, feed.id)))})`,
			),
		);
	const isNews = or(eq(automationRun.state, "failed"), posted);
	return {
		feed,
		unread: sql<boolean>`(${isNews} and ${nestedChatUnreadBy(db, input.personId, {
			chatId: feed.id,
			nestedChatId: automationRun.chatId,
			at: sql`coalesce(${automationRun.finishedAt}, ${automationRun.acceptedAt})`,
		})})`,
		mentionsYou: sql<boolean>`exists (${resultMentioningYou})`,
		listed: and(
			eq(feed.workspaceId, input.workspaceId),
			input.reachesChat(feed),
			gt(automationRun.acceptedAt, input.since),
			or(ne(automationRun.state, "completed"), posted),
		),
	};
}

/** How many answered approvals the approvals page lists, newest first. */
const ANSWERED_APPROVALS = 50;
/** At most this many waiting approvals are listed; more than this many waiting is a backlog to clear in its chats. */
const WAITING_APPROVALS = 100;

/**
 * Which approvals `personId` may decide in the chats they reach, by
 * `mayDecideToolCall`, the rule deciding an approval checks: by their
 * standing in the project of the chat a call's chat belongs
 * to, with the bot doing the run for a call raised in an automation's
 * run, and, for a request to change a computer, in the computer's project.
 * That project need not be one they reach: an administrator decides a private
 * bot's computer requests, raised in a collaboration they can see, without
 * reaching the bot's chats.
 *
 * `decidable` is that rule's answer for every project, run's bot and
 * computer a waiting call needs, for SQL to select the calls by: it repeats
 * no rule of its own, so it stays in step with `mayDecideToolCall`.
 */
const approversIn = Effect.fn("ChatView.approversIn")(function* (
	db: Executor,
	workspaceId: string,
	personId: string,
) {
	const projects = new Map(
		(yield* projectStandingsFor(db, workspaceId, personId)).map((standing) => [
			standing.project.id,
			standing,
		]),
	);
	const unreachedComputerProjectIds = (yield* waitingComputerRequestProjectIds(
		db,
		workspaceId,
	)).filter((id) => !projects.has(id));
	const computerProjects = new Map(projects);
	for (const standing of yield* projectStandingsOf(db, unreachedComputerProjectIds, personId)) {
		computerProjects.set(standing.project.id, standing);
	}
	/**
	 * `projectId` is the project of the chat the call's chat
	 * belongs to; `computerProjectId` the project whose computer the asking
	 * turn worked on; `runBot` the bot doing the run the call was raised in.
	 */
	const mayDecide = (
		projectId: string | null,
		computerProjectId: string | null,
		runBot: BotFacts | null,
		approvers: ToolApprovers,
	) => {
		const standing = projectId === null ? undefined : projects.get(projectId);
		return mayDecideToolCall(
			standing,
			computerProjectId === null ? undefined : computerProjects.get(computerProjectId),
			runBot ?? undefined,
			approvers,
		);
	};
	const waitingInRuns = yield* waitingRunApprovals(db, workspaceId);
	const decidable: Decidable = {
		outsideRuns: [...projects.keys()].filter((id) => mayDecide(id, null, null, "chat")),
		inRuns: waitingInRuns.flatMap(({ projectId, runBotId, runBot }) =>
			projectId !== null && runBotId !== null && mayDecide(projectId, null, runBot, "chat")
				? [{ projectId, runBotId }]
				: [],
		),
		computerRequests: [...computerProjects.keys()].filter((id) =>
			mayDecide(null, id, null, "computer-managers"),
		),
	};
	return { mayDecide, decidable };
});

/** The projects whose computers a waiting request to change a computer in the workspace is for. */
const waitingComputerRequestProjectIds = Effect.fn("ChatView.waitingComputerRequestProjectIds")(
	function* (db: Executor, workspaceId: string) {
		const asking = alias(placedChat, "asking_chat");
		const rows = yield* db
			.selectDistinct({ projectId: computerProjectIdOf(asking, turn.botId) })
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.chatId))
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
 * The project of the chat each waiting call raised in an automation's run
 * in the workspace belongs to, with the bot doing the run, once for each
 * pair, as `mayDecideToolCall` decides a run's calls by both. Requests to
 * change a computer are decided by the computer's project instead.
 */
const waitingRunApprovals = Effect.fn("ChatView.waitingRunApprovals")(function* (
	db: Executor,
	workspaceId: string,
) {
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	return yield* db
		.selectDistinct({
			projectId: chat.projectId,
			runBotId: runBotIdOf(asking.id),
			runBot: runBotFactsOf(asking.id),
		})
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.chatId))
		.innerJoin(chat, eq(chat.id, asking.rootChatId))
		.where(
			and(
				eq(asking.workspaceId, workspaceId),
				eq(toolCall.approvalStatus, "pending"),
				notInArray(toolCall.tool, [...COMPUTER_REQUEST_TOOLS]),
				isNotNull(runBotIdOf(asking.id)),
			),
		);
});

/**
 * Where a person may decide approvals: the projects whose chats' approvals
 * they decide outside automations' runs; each project and run's bot whose
 * runs' approvals they decide there; and the projects whose computer's
 * requests they decide (see `approversOf`).
 */
interface Decidable {
	outsideRuns: readonly string[];
	inRuns: ReadonlyArray<{ projectId: string; runBotId: string }>;
	computerRequests: readonly string[];
}

/**
 * The tool calls waiting on a decision `decidable` allows, in chats
 * `reachesChat` reaches, oldest first, each with the bot that asked and its
 * chat.
 */
const waitingApprovalRows = Effect.fn("ChatView.waitingApprovalRows")(function* (
	db: Executor,
	decidable: Decidable,
	reachesChat: Visibility.ReachesChat,
) {
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	const waiting = waitingOnDecision(decidable, asking, chat, reachesChat);
	if (!waiting) return [];
	return yield* selectApprovals(db, asking, chat)
		.where(waiting)
		.orderBy(asc(toolCall.startedAt))
		.limit(WAITING_APPROVALS);
});

/** How many approvals wait on a decision `decidable` allows, every one of them rather than a page. */
const waitingApprovalCount = Effect.fn("ChatView.waitingApprovalCount")(function* (
	db: Executor,
	decidable: Decidable,
	reachesChat: Visibility.ReachesChat,
) {
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	const waiting = waitingOnDecision(decidable, asking, chat, reachesChat);
	if (!waiting) return 0;
	const [counted] = yield* db
		.select({ waiting: sql<number>`count(*)::int` })
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.chatId))
		.innerJoin(chat, eq(chat.id, asking.rootChatId))
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.where(waiting);
	return counted?.waiting ?? 0;
});

/**
 * Whether a tool call, joined to the chat it asks in, `asking`, the
 * chat that belongs to, `chat`, and its turn, waits on a
 * decision `decidable` allows in a chat `reachesChat`
 * reaches. Undefined when `decidable` allows none.
 */
function waitingOnDecision(
	decidable: Decidable,
	asking: AskingChat,
	chat: ApprovalChat,
	reachesChat: Visibility.ReachesChat,
): SQL | undefined {
	const computerRequest = inArray(toolCall.tool, [...COMPUTER_REQUEST_TOOLS]);
	const inRun = isNotNull(runIdOf(asking.id));
	const conditions: SQL[] = [];
	if (decidable.outsideRuns.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and ${inArray(chat.projectId, [...decidable.outsideRuns])} and not ${inRun}`,
		);
	}
	if (decidable.inRuns.length > 0) {
		conditions.push(
			sql`not ${computerRequest} and (${chat.projectId}, ${runBotIdOf(asking.id)}) in (${sql.join(
				decidable.inRuns.map(
					({ projectId, runBotId }) => sql`(${projectId}::uuid, ${runBotId}::uuid)`,
				),
				sql`, `,
			)})`,
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
	return and(eq(toolCall.approvalStatus, "pending"), or(...conditions), reachesChat(asking));
}

/**
 * The tool calls answered in chats `reachesChat` reaches, newest answer
 * first, each with the bot that asked and its chat.
 */
const answeredApprovalRows = Effect.fn("ChatView.answeredApprovalRows")(function* (
	db: Executor,
	workspaceId: string,
	reachesChat: Visibility.ReachesChat,
) {
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	return yield* selectApprovals(db, asking, chat)
		.where(
			and(
				eq(asking.workspaceId, workspaceId),
				inArray(toolCall.approvalStatus, ["allowed", "denied"]),
				isNotNull(toolCall.decidedAt),
				reachesChat(asking),
			),
		)
		.orderBy(desc(toolCall.decidedAt))
		.limit(ANSWERED_APPROVALS);
});

/**
 * Tool calls with the bot that asked, the chat they are in, and who answered.
 * `asking` is the chat a call was made in, aliased because
 * `runIdOf` reads `chat` itself.
 */
function selectApprovals(db: Executor, asking: AskingChat, chat: ApprovalChat) {
	const approver = alias(person, "approver");
	return db
		.select({
			call: toolCall,
			// A collaboration's is the project of the chat it was opened from.
			projectId: listedProjectIdOf(chat),
			rootChatId: asking.rootChatId,
			bot: {
				id: bot.id,
				name: bot.name,
				handle: bot.handle,
				color: bot.color,
				eyes: bot.eyes,
				shape: bot.shape,
			},
			decidedByName: approver.name,
		})
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.chatId))
		.innerJoin(chat, eq(chat.id, asking.rootChatId))
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(bot, eq(bot.id, turn.botId))
		.leftJoin(approver, eq(approver.id, toolCall.decidedById))
		.$dynamic();
}

type AskingChat = ReturnType<typeof alias<typeof placedChat, "asking_chat">>;

/** The chat the asking chat belongs to. */
type ApprovalChat = ReturnType<typeof alias<typeof placedChat, "approval_chat">>;

type ApprovalRow = Effect.Success<ReturnType<typeof answeredApprovalRows>>[number];

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
	return {
		call: toToolCallPart(row.call, row.decidedByName),
		bot: { kind: "bot", ...row.bot },
		projectId: row.projectId,
		chatId: row.call.chatId,
		rootChatId: row.rootChatId,
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
 * Those of `chatIds` with a tool call waiting for a decision `personId`
 * may make, by the rule deciding the approval checks.
 */
const chatsAwaitingDecisionBy = Effect.fn("ChatView.chatsAwaitingDecisionBy")(function* (
	db: Executor,
	{
		workspaceId,
		personId,
		chatIds,
	}: { workspaceId: string; personId: string; chatIds: readonly string[] },
) {
	if (chatIds.length === 0) return new Set<string>();
	// Aliased, because `runIdOf` reads `chat` itself, and an
	// unaliased column would name its row rather than this one.
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	const pending = yield* db
		.selectDistinct({
			rootChatId: asking.rootChatId,
			projectId: chat.projectId,
			computerProjectId: computerProjectIdOf(asking, turn.botId),
			runBot: runBotFactsOf(asking.id),
			tool: toolCall.tool,
		})
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.chatId))
		.innerJoin(chat, eq(chat.id, asking.rootChatId))
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.where(and(inArray(asking.rootChatId, [...chatIds]), eq(toolCall.approvalStatus, "pending")));
	if (pending.length === 0) return new Set<string>();
	const { mayDecide } = yield* approversIn(db, workspaceId, personId);
	return new Set(
		// The chats are ones the person reaches, so their standing decides.
		pending.flatMap(({ rootChatId, projectId, computerProjectId, runBot, tool }) =>
			rootChatId && mayDecide(projectId, computerProjectId, runBot, approversOf(tool))
				? [rootChatId]
				: [],
		),
	);
});

/**
 * The project a chat is listed under, as `placedChat` or an
 * alias of it reads: a project people made. A bot's chat, in its default
 * project, is listed under the bot, so it has none.
 */
function listedProjectIdOf(row: { projectId: SQLWrapper; botId: SQLWrapper }): SQL<string | null> {
	return sql<string | null>`case when ${row.botId} is null then ${row.projectId} end`;
}

/** A chat as a list sorts it: by its newest message, or by when it began. */
interface ListedByLatest {
	readonly lastMessage: { readonly at: string } | null;
	readonly chat: { readonly createdAt: string };
}

/** Newest message first; one nothing is written in yet by when it began. */
function byLatestMessage(left: ListedByLatest, right: ListedByLatest): number {
	const leftAt = left.lastMessage?.at ?? left.chat.createdAt;
	const rightAt = right.lastMessage?.at ?? right.chat.createdAt;
	return rightAt.localeCompare(leftAt);
}

/**
 * A page of the chat: its messages with their authors and parts, and
 * its automation runs, each newest first and one more than the page. Nothing
 * when `reachesChat` does not reach the chat.
 */
const loadMainPage = Effect.fn("ChatView.loadMainPage")(function* (
	db: Executor,
	chatId: string,
	reachesChat: Visibility.ReachesChat,
	limit: number,
	before: CursorPoint | undefined,
) {
	const chat = yield* db.query.placedChat.findFirst({
		where: {
			id: chatId,
			kind: { in: [...OPENABLE_CHAT_KINDS] },
			RAW: (row) => reachesChat(row),
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
	if (!chat) return undefined;
	const automationRuns = yield* db.query.automationRun.findMany({
		limit: limit + 1,
		orderBy: { acceptedAt: "desc", id: "desc" },
		where: {
			RAW: (row) =>
				and(
					// Each run of an automation is listed in its feed.
					sql`${row.automationId} in (select ${automationFeed.automationId} from ${automationFeed} where ${automationFeed.chatId} = ${chatId})`,
					before && earlierThan(row.acceptedAt, row.id, before),
				) ?? sql`true`,
		},
		columns: {
			id: true,
			chatId: true,
			automationName: true,
			triggerKind: true,
			acceptedAt: true,
			state: true,
			error: true,
		},
		extras: {
			report: (row) => lastReplyIn(db, row.chatId),
			posted: (row) => resultPosted(sql`${row.id}`),
		},
	});
	const [paused] = yield* db
		.select({ automationId: automation.id, at: automation.pausedAfterFailuresAt })
		.from(automation)
		.innerJoin(placedChat, eq(placedChat.automationId, automation.id))
		.where(eq(placedChat.id, chatId))
		.limit(1);
	// On the page whose span it falls in: the first, or one before where it happened.
	const pausedAfterFailures =
		paused?.at && (!before || paused.at < before.at)
			? { automationId: paused.automationId, at: paused.at }
			: null;
	return { ...chat, automationRuns, pausedAfterFailures };
});

/** The status of the newest turn in `chatId`, or null when it has none. */
function latestTurnStatusIn(chatId: SQLWrapper): SQL<schema.TurnRow["status"] | null> {
	return sql<schema.TurnRow["status"] | null>`(
		select ${turn.status} from ${turn}
		where ${turn.chatId} = ${chatId}
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
					chatId: execution.chatId,
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
 * A page of the chats opened beside the chat, one statement: its
 * automation runs and collaborations, each newest activity first and one more
 * than the page. Nothing when `reachesChat` does not reach the
 * chat.
 */
const loadHistory = Effect.fn("ChatView.loadHistory")(function* (
	db: Executor,
	chatId: string,
	reachesChat: Visibility.ReachesChat,
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
				with: { person: personColumns, bot: botColumns },
			},
			automationRun: {
				columns: { id: true, automationId: true, automationName: true, trigger: true, state: true },
			},
		},
	} satisfies DBQueryConfig<"many", typeof relations, (typeof relations)["placedChat"]>;
	return yield* db.query.placedChat.findFirst({
		where: {
			id: chatId,
			kind: { in: [...OPENABLE_CHAT_KINDS] },
			RAW: (row) => reachesChat(row),
		},
		columns: { id: true },
		with: { rootedChats: items },
	});
});

type HistoryRow = NonNullable<Effect.Success<ReturnType<typeof loadHistory>>>;

/** The collaborations and runs, loaded newest activity first, cut to the page. */
function toHistoryPage(row: HistoryRow, limit: number) {
	const rooted = row.rootedChats;
	const page = rooted.slice(0, limit);
	const items = page.flatMap((side): ChatHistoryEntry[] => {
		if (side.kind !== "collaboration" && side.kind !== "run") return [];
		// A run's own row; a collaboration has none.
		const execution = side.kind === "run" ? side.automationRun : null;
		return [
			{
				chatId: side.id,
				parentChatId: side.parentChatId,
				kind: side.kind,
				title: side.title,
				participants: side.participants.map(({ person: somebody, bot: participant }) =>
					toParticipant(authorRow(somebody, participant)),
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

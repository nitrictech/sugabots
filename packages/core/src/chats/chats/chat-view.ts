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
	WorkspaceApprovals,
} from "@sugabots/contracts";
import {
	GROUP_MENTION_HANDLES,
	handleFromName,
	mentionPattern,
	messagePreview,
	textWithoutNarration,
} from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
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
import { Context, DateTime, Effect, Layer } from "effect";
import { type Database, type Executor, query, serviceOperations } from "../../database/database.ts";
import type { relations } from "../../database/relations.ts";
import type * as schema from "../../database/schema.ts";
import {
	automation,
	automationFeed,
	automationRun,
	bot,
	member,
	message,
	OPENABLE_CHAT_KINDS,
	placedChat,
	project,
	readCursor,
	toolCall,
	turn,
} from "../../database/schema.ts";
import {
	type ApproverStanding,
	approvedCalls,
	approverStandingIn,
} from "../../proofs/approvers.ts";
import { memberActing } from "../../proofs/facts.ts";
import type { ChatColumns, ReachSet } from "../../proofs/reach-set.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import type { CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { stateWithPendingPause } from "../automations/automation.ts";
import {
	latestRunOf,
	listStatusColumns,
	resultPosted,
	toListStatus,
	unseenAutomationFailure,
} from "../automations/execution.ts";
import {
	type CursorPoint,
	earlierThan,
	encodeCursor,
	type InvalidCursor,
	parseCursor,
} from "../cursor.ts";
import {
	authorRow,
	botColumns,
	memberColumns,
	messageFromRelations,
	messageRelations,
	namedMemberColumns,
	recentParticipantsOf,
	toParticipant,
} from "../store/participants.ts";
import { toToolCallPart } from "../store/tool-calls.ts";
import { fixedApprovalInput } from "../tools/approvers.ts";
import { Turns } from "../turns/turns.ts";
import { toAutomationFeed, toProjectChat } from "./chat.ts";

/**
 * What the chat screens show, of what an operation has proved its principal
 * reaches: a project's chats (a bot's are its default project's), a chat's
 * two timelines, and how much across a workspace waits for the member
 * acting. Each method takes the workspace, project or chat from its proofs.
 */
export interface Interface {
	/**
	 * The chats and automations of the project `reach` is about, a bot's
	 * default project included, as the member acting sees them: nobody, who
	 * has read nothing, for a principal acting for no member.
	 */
	readonly chats: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<ProjectChatList>;
	/**
	 * How each project of the workspace `reach` reaches, bots' default
	 * projects included, stands for the member `canRead` names: its chats' and
	 * automation feeds' unread messages, whether any waits on their decision,
	 * and how many of its automations are failing unseen.
	 */
	readonly attentionMarks: <P, W>(
		canRead: CanReadWorkspace<P, W>,
		reach: ReachSet<P, W>,
	) => Effect.Effect<AttentionMarks>;
	/**
	 * The approvals across the workspace for the member `canRead` names: those
	 * waiting on a decision they may make, and the latest answered in chats
	 * `reach` reaches.
	 */
	readonly approvals: <P, W>(
		canRead: CanReadWorkspace<P, W>,
		reach: ReachSet<P, W>,
	) => Effect.Effect<WorkspaceApprovals>;
	/**
	 * How much in the workspace waits for the member `canRead` names:
	 * approvals they may decide, and unread messages and automation results
	 * that mention them, over the last `ATTENTION_WINDOW_DAYS`, in chats
	 * `reach` reaches.
	 */
	readonly attention: <P, W>(
		canRead: CanReadWorkspace<P, W>,
		reach: ReachSet<P, W>,
	) => Effect.Effect<AttentionCounts>;
	/**
	 * The newest `limit` messages, over the last `ATTENTION_WINDOW_DAYS`, that
	 * mention the member `canRead` names and they have not read, in chats
	 * `reach` reaches.
	 */
	readonly unreadMentions: <P, W>(
		canRead: CanReadWorkspace<P, W>,
		reach: ReachSet<P, W>,
		limit: number,
	) => Effect.Effect<UnreadMention[]>;
	/**
	 * A page of the chat `reach` is about, newest last. Only a chat members
	 * open; any other is hidden.
	 */
	readonly messages: <P, C>(
		reach: ReachesChat<P, C>,
		page: ChatPageQuery,
	) => Effect.Effect<ChatMessagesPage, ResourceHidden | InvalidCursor>;
	/** A page of the chats opened beside the chat, newest activity first. */
	readonly history: <P, C>(
		reach: ReachesChat<P, C>,
		page: ChatPageQuery,
	) => Effect.Effect<ChatHistoryPage, ResourceHidden | InvalidCursor>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ChatView") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatView");

	return Service.of({
		chats: (reach) =>
			operation(
				"chats",
				Effect.gen(function* () {
					const projectId = reach.project.value;
					yield* Effect.annotateCurrentSpan("chat.list.project", projectId);
					const member = memberActing(reach.as)?.actor.memberId;
					const memberId = member ?? NOBODY;
					// The chats listed, their runs' included, are in the project the member reaches.
					const approver =
						member === undefined
							? undefined
							: query((db) =>
									approverStandingIn(db, reach.workspace, member, () => sql<boolean>`true`),
								);
					const rows = yield* query((db) => projectChats(db, projectId));
					const chats = yield* listedChats(memberId, approver, rows);
					const owned = yield* query((db) => listedAutomations(db, projectId));
					const feedMentions = yield* query((db) =>
						unreadMentionsIn(
							db,
							memberId,
							owned.flatMap((row) => (row.feed ? [row.feed.id] : [])),
						),
					);
					const automations = owned.map((row) => ({
						automation: {
							id: row.automation.id,
							name: row.automation.name,
							state: stateWithPendingPause(row.automation),
							pausedAfterFailures:
								row.automation.pausedAfterFailuresAt !== null ||
								row.automation.pauseAfterFailuresPendingAt !== null,
						},
						chat: row.feed && toAutomationFeed(row.feed),
						mentionsYou: row.feed !== null && feedMentions.has(row.feed.id),
						status: toListStatus(row),
					}));
					return { chats, automations };
				}),
			),

		attentionMarks: (canRead, reach) =>
			operation(
				"attentionMarks",
				Effect.gen(function* () {
					const workspaceId = reach.workspace.value;
					const { memberId } = canRead.actor;
					const chats = yield* query((db) =>
						projectChatsReached(db, workspaceId, reach.reachesProject),
					);
					const approver = query((db) =>
						approverStandingIn(db, workspaceId, memberId, reach.reachesChat),
					);
					const marksOf = yield* chatMarks(
						memberId,
						approver,
						chats.map(({ id }) => id),
					);
					const failed = yield* query((db) =>
						failingAutomationsByProject(db, workspaceId, reach.reachesProject, memberId),
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

		approvals: (canRead, reach) =>
			operation(
				"approvals",
				approvalsFor(reach.workspace.value, canRead.actor.memberId, reach.reachesChat),
			),

		attention: (canRead, reach) =>
			operation(
				"attention",
				Effect.gen(function* () {
					const workspaceId = reach.workspace.value;
					const { memberId } = canRead.actor;
					const approver = yield* query((db) =>
						approverStandingIn(db, workspaceId, memberId, reach.reachesChat),
					);
					const waitingApprovals = yield* query((db) =>
						waitingApprovalCount(db, workspaceId, approver),
					);
					const scope = yield* attentionScopeIn({
						workspaceId,
						memberId,
						reachesChat: reach.reachesChat,
					});
					const messages = yield* query((db) => unreadMentionCount(db, scope));
					const runs = yield* query((db) => unreadRunMentionCount(db, scope));
					return { waitingApprovals, unreadForYou: messages + runs };
				}),
			),

		unreadMentions: (canRead, reach, limit) =>
			operation(
				"unreadMentions",
				Effect.gen(function* () {
					const scope = yield* attentionScopeIn({
						workspaceId: reach.workspace.value,
						memberId: canRead.actor.memberId,
						reachesChat: reach.reachesChat,
					});
					const messages = yield* query((db) => unreadMentionRows(db, scope, limit));
					return messages.map(
						(row): UnreadMention => ({
							messageId: row.id,
							authorName: toParticipant(authorRow(row.authorMember, row.authorBot)).name,
							preview: replyPreview(row),
							chatId: row.chatId,
							projectSlug: row.defaultOfBotId === null ? row.projectSlug : null,
						}),
					);
				}),
			),

		messages: (reach, page) =>
			operation(
				"messages",
				Effect.gen(function* () {
					const chatId = reach.chat.value;
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					// Before the query, so a bad cursor says nothing about the chat.
					const before = page.cursor ? yield* parseCursor(page.cursor) : undefined;
					const row = yield* query((db) =>
						loadMessagesPage(db, { chatId, workspaceId: reach.workspace }, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return toMessagesPage(row, page.limit);
				}),
			),

		history: (reach, page) =>
			operation(
				"history",
				Effect.gen(function* () {
					const chatId = reach.chat.value;
					yield* Effect.annotateCurrentSpan("chat.id", chatId);
					const before = page.cursor ? yield* parseCursor(page.cursor) : undefined;
					const row = yield* query((db) =>
						loadHistory(db, { chatId, workspaceId: reach.workspace }, page.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return toHistoryPage(row, page.limit);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/** SQL for "the reader reaches this chat", given its columns: a `ReachSet`'s, or the current actor's. */
type ReachesChatSql = (chat: ChatColumns) => SQL<boolean>;

/** SQL for "the reader reaches this project", given the column naming it. */
type ReachesProjectSql = (projectId: SQLWrapper) => SQL<boolean>;

/**
 * Whom a view is shown to when the principal acts for no member, such as an
 * automation's run: no member's id, so they have read nothing and are
 * mentioned nowhere.
 */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * The approvals across the workspace for `memberId`: those waiting on a
 * decision they may make, and the latest answered, in chats `reachesChat`
 * reaches.
 */
const approvalsFor = (workspaceId: string, memberId: string, reachesChat: ReachesChatSql) =>
	Effect.gen(function* () {
		const approver = yield* query((db) =>
			approverStandingIn(db, workspaceId, memberId, reachesChat),
		);
		const waiting = yield* query((db) => waitingApprovalRows(db, workspaceId, approver));
		const answered = yield* query((db) => answeredApprovalRows(db, workspaceId, reachesChat));
		return {
			waiting: waiting.map(toApprovalRequest),
			answered: answered.flatMap((row): AnsweredApproval[] => {
				const answer = answerOf(row);
				return answer ? [{ ...toApprovalRequest(row), answer }] : [];
			}),
		};
	});

/**
 * How each of the chats stands for `memberId`: its unread messages, and
 * whether it waits on a decision they may make, by their standing as an
 * approver, which `approver` loads only once a call waits there. None does for
 * a principal acting for no member.
 */
const chatMarks = Effect.fn("ChatView.chatMarks")(function* (
	memberId: string,
	approver: LoadsApproverStanding | undefined,
	chatIds: readonly string[],
) {
	const unread = yield* query((db) => unreadMessageCounts(db, memberId, chatIds));
	const awaiting = approver ? yield* chatsAwaitingDecisionBy(approver, chatIds) : new Set<string>();
	return (chatId: string) => ({
		unreadMessages: unread.get(chatId) ?? 0,
		needsApproval: awaiting.has(chatId),
	});
});

/**
 * The chats `rows` as a project's list shows them to `memberId`: each with
 * its latest message, how many it holds, who has written in it lately,
 * and how it stands for them, newest message first.
 */
const listedChats = Effect.fn("ChatView.listedChats")(function* (
	memberId: string,
	approver: LoadsApproverStanding | undefined,
	rows: readonly ProjectChatRow[],
) {
	const chatIds = rows.map((row) => row.chat.id);
	const lastMessageTimes = yield* query((db) => lastMessageTimesOf(db, chatIds));
	const counts = yield* query((db) => messageCounts(db, chatIds));
	const marksOf = yield* chatMarks(memberId, approver, chatIds);
	const mentioning = yield* query((db) => unreadMentionsIn(db, memberId, chatIds));
	const statuses = yield* chatStatuses(memberId, chatIds);
	const listed = rows.map((row): ListedChat => {
		return {
			chat: toProjectChat(row.chat),
			lastMessageAt: lastMessageTimes.get(row.chat.id)?.toISOString() ?? null,
			participants: row.participants.map(toParticipant),
			messageCount: counts.get(row.chat.id) ?? 0,
			...marksOf(row.chat.id),
			mentionsYou: mentioning.has(row.chat.id),
			status: statuses.get(row.chat.id) ?? null,
		};
	});
	return listed.sort(byLatestMessage);
});

/** A project's attention mark before any of its chats or automations is counted. */
const NOTHING_NEW: AttentionMark = {
	unreadMessages: 0,
	needsApproval: false,
	failedAutomations: 0,
};

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
	reachesProject: ReachesProjectSql,
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

/** When the newest message with words in it was written in each chat, in one query. */
const lastMessageTimesOf = Effect.fn("ChatView.lastMessageTimesOf")(function* (
	db: Executor,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Map<string, Date>();
	const rows = yield* db
		.select({
			chatId: message.chatId,
			at: sql<Date>`max(${message.createdAt})`.mapWith(message.createdAt),
		})
		.from(message)
		.where(and(inArray(message.chatId, [...chatIds]), ne(message.content, "")))
		.groupBy(message.chatId);
	return new Map(rows.map((row) => [row.chatId, row.at]));
});

/**
 * How many messages with words in them somebody other than `memberId` finished on
 * each of the chats since `memberId` caught up with it, by `caughtUpAt`.
 * Chats with none are left out.
 */
const unreadMessageCounts = Effect.fn("ChatView.unreadMessageCounts")(function* (
	db: Executor,
	memberId: string,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Map<string, number>();
	const rows = yield* db
		.select({ chatId: message.chatId, count: sql<number>`count(*)::int` })
		.from(message)
		.where(
			and(
				inArray(message.chatId, [...chatIds]),
				finishedWordsFromOthers(memberId),
				unreadBy(db, memberId, { chatId: message.chatId, at: message.createdAt }),
			),
		)
		.groupBy(message.chatId);
	return new Map(rows.map((row) => [row.chatId, row.count]));
});

/** The handle mentions of `memberId` use, or `undefined` when they have no account. */
const memberHandleOf = Effect.fn("ChatView.memberHandleOf")(function* (
	db: Executor,
	memberId: string,
) {
	const [somebody] = yield* db
		.select({ name: member.name })
		.from(member)
		.where(eq(member.id, memberId))
		.limit(1);
	return somebody && handleFromName(somebody.name);
});

/** Those of the chats with a message `memberId` has not read that mentions them. */
const unreadMentionsIn = Effect.fn("ChatView.unreadMentionsIn")(function* (
	db: Executor,
	memberId: string,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Set<string>();
	const handle = yield* memberHandleOf(db, memberId);
	if (handle === undefined) return new Set<string>();
	const rows = yield* db
		.selectDistinct({ chatId: message.chatId })
		.from(message)
		.where(
			and(
				inArray(message.chatId, [...chatIds]),
				finishedWordsFromOthers(memberId),
				mentions(handle),
				unreadBy(db, memberId, { chatId: message.chatId, at: message.createdAt }),
			),
		);
	return new Set(rows.map((row) => row.chatId));
});

/**
 * What the bots are doing in each of the chats, as `memberId`'s list
 * shows it, by its id; one with nothing to show is left out. A turn waiting on
 * an approval comes first, as it waits on a member; then a turn working on a
 * reply; then, with neither, a reply the latest turn to end finished that
 * `memberId` has not caught up with.
 */
const chatStatuses = Effect.fn("ChatView.chatStatuses")(function* (
	memberId: string,
	chatIds: readonly string[],
) {
	const statuses = new Map<string, ChatStatus>();
	if (chatIds.length === 0) return statuses;
	const active = yield* query((db) => activeTurnsIn(db, chatIds));
	const ended = yield* query((db) => latestEndedTurnsIn(db, memberId, chatIds));
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
 * and whether its reply is one `memberId` has not caught up with.
 */
const latestEndedTurnsIn = Effect.fn("ChatView.latestEndedTurnsIn")(function* (
	db: Executor,
	memberId: string,
	chatIds: readonly string[],
) {
	const unreadReply = db
		.select({ id: message.id })
		.from(message)
		.where(
			and(
				eq(message.turnId, turn.id),
				finishedWordsFromOthers(memberId),
				unreadBy(db, memberId, { chatId: message.chatId, at: message.createdAt }),
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

/** A `message` with words in it, finished, written by somebody other than `memberId`. */
function finishedWordsFromOthers(memberId: string): SQL | undefined {
	return and(
		ne(message.content, ""),
		ne(message.status, "writing"),
		sql`${message.authorMemberId} is distinct from ${memberId}`,
	);
}

/**
 * Whether `memberId` has yet to catch up with something that happened in
 * `chatId` at `at`, by `caughtUpAt`.
 */
function unreadBy(
	db: Executor,
	memberId: string,
	{ chatId, at }: { chatId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`coalesce(${at} > ${caughtUpAt(db, memberId, chatId)}, true)`;
}

/**
 * Whether `memberId` has yet to catch up with an automation run that ended
 * at `at`: neither the chat it is listed in, `chatId`, nor its own chat,
 * `nestedChatId`, read past then. Opening the run as a page of its own reads
 * its own chat, so it reads that run alone.
 */
function nestedChatUnreadBy(
	db: Executor,
	memberId: string,
	{ chatId, nestedChatId, at }: { chatId: SQLWrapper; nestedChatId: SQLWrapper; at: SQLWrapper },
): SQL<boolean> {
	return sql<boolean>`(${unreadBy(db, memberId, { chatId, at })} and ${unreadBy(db, memberId, { chatId: nestedChatId, at })})`;
}

/**
 * When `memberId` last caught up with `chatId`: the later of how far they
 * have read it and the last message they wrote there, or null when neither.
 *
 * A reply is stamped when it began. Reading never moves past a reply still
 * being written, so one the member read around still counts once it is done.
 * Writing does: a reply that began before the member's last message counts
 * as caught up with, even if it finished after, because a message does not
 * keep when it finished.
 */
function caughtUpAt(db: Executor, memberId: string, chatId: SQLWrapper): SQL<Date | null> {
	const own = alias(message, "own_message");
	// Through `sql`, because a timestamp column selected bare is cast to text for reading.
	const readThrough = db
		.select({ at: sql`${readCursor.readThrough}` })
		.from(readCursor)
		.where(and(sql`${readCursor.chatId} = ${chatId}`, eq(readCursor.memberId, memberId)));
	const lastWritten = db
		.select({ at: sql`max(${own.createdAt})` })
		.from(own)
		.where(and(sql`${own.chatId} = ${chatId}`, eq(own.authorMemberId, memberId)));
	return sql<Date | null>`greatest((${readThrough}), (${lastWritten}))`;
}

/**
 * Whether a `message` mentions `handle`, or is a member's `@here` or
 * `@channel`. A bot's or an automation's notifies nobody, so it mentions
 * nobody.
 */
function mentions(handle: string): SQL {
	return sql`(${message.content} ~* ${mentionPattern(handle)} or (${message.authorMemberId} is not null and ${message.content} ~* ${mentionPattern(...GROUP_MENTION_HANDLES)}))`;
}

/** How far back what waits for a member goes: past this, a message is old news, read or not. */
const ATTENTION_WINDOW_DAYS = 30;

/**
 * The newest `limit` messages in the project chats `input.memberId` reaches,
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
			authorMember: namedMemberColumns,
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
		.leftJoin(member, eq(member.id, message.authorMemberId))
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
 * chats whose messages notify members.
 */
const inProjectChat = and(eq(placedChat.id, message.chatId), eq(placedChat.kind, "project_chat"));

/**
 * Whether a `message`, joined to its `placedChat` by `inProjectChat`, is in
 * the workspace and reached, since `input.since`, finished by somebody else,
 * mentions the member and is unread by them.
 */
function unreadMentionOf(db: Executor, input: AttentionScope) {
	return and(
		eq(placedChat.workspaceId, input.workspaceId),
		input.reachesChat(placedChat),
		gt(message.createdAt, input.since),
		finishedWordsFromOthers(input.memberId),
		mentions(input.handle),
		unreadBy(db, input.memberId, { chatId: message.chatId, at: message.createdAt }),
	);
}

/** A message that mentions the member and that they have not read. */
interface UnreadMention {
	messageId: string;
	authorName: string;
	/** The start of what it says. */
	preview: string;
	/** The chat it was written in. */
	chatId: string;
	/** The project members made that the chat is in; null in a bot's chat. */
	projectSlug: string | null;
}

/**
 * What is looked through for `memberId` in the workspace `workspaceId`, which
 * they are in and where `reachesChat` is what they reach. Being in the
 * workspace means they have an account, as their memberships are removed
 * with their accounts.
 */
const attentionScopeIn = Effect.fn("ChatView.attentionScopeIn")(function* (
	reached: Pick<AttentionScope, "workspaceId" | "memberId" | "reachesChat">,
) {
	const handle = yield* query((db) => memberHandleOf(db, reached.memberId));
	if (handle === undefined) {
		return yield* Effect.die(new Error("A member in the workspace has no account"));
	}
	const since = DateTime.toDate(
		DateTime.subtract(yield* DateTime.now, { days: ATTENTION_WINDOW_DAYS }),
	);
	return { ...reached, handle, since } satisfies AttentionScope;
});

interface AttentionScope {
	workspaceId: string;
	reachesChat: ReachesChatSql;
	memberId: string;
	/** The member's handle, which mentions of them use. */
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
 * with automations failing that `memberId` has not opened since, and how many
 * each has.
 */
const failingAutomationsByProject = Effect.fn("ChatView.failingAutomationsByProject")(function* (
	db: Executor,
	workspaceId: string,
	reachesProject: ReachesProjectSql,
	memberId: string,
) {
	const rows = yield* db
		.select({ projectId: automation.projectId, count: sql<number>`count(*)::int` })
		.from(automation)
		.where(
			and(
				eq(automation.workspaceId, workspaceId),
				isNull(automation.deletedAt),
				reachesProject(automation.projectId),
				unseenAutomationFailure(memberId),
			),
		)
		.groupBy(automation.projectId);
	return new Map(rows.map((row) => [row.projectId, row.count] as const));
});

/**
 * How many automation runs in the feeds the member reaches, since
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
 * member. A run is unread only once it posted a result or failed, from when
 * it ended. It mentions the member when its result, posted only in the
 * automation's feed, does.
 */
function runAttentionTerms(db: Executor, input: AttentionScope) {
	const feed = alias(placedChat, "feed");
	const posted = resultPosted(automationRun.id);
	const resultMentioningYou = db
		.select({ id: message.id })
		.from(message)
		.where(and(eq(message.runId, automationRun.id), mentions(input.handle)));
	const isNews = or(eq(automationRun.state, "failed"), posted);
	return {
		feed,
		unread: sql<boolean>`(${isNews} and ${nestedChatUnreadBy(db, input.memberId, {
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
export const WAITING_APPROVALS = 100;

/**
 * The tool calls waiting on a decision the member `approver` describes may
 * make in the workspace, oldest first, each with the bot that asked.
 */
const waitingApprovalRows = Effect.fn("ChatView.waitingApprovalRows")(function* (
	db: Executor,
	workspaceId: string,
	approver: ApproverStanding,
) {
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	return yield* selectApprovals(db, asking, chat, approver.reachesChat(asking))
		.where(waitingOn(db, workspaceId, approver, asking))
		.orderBy(asc(toolCall.startedAt))
		.limit(WAITING_APPROVALS);
});

/** How many approvals wait on a decision `approver` may make, every one of them rather than a page. */
const waitingApprovalCount = Effect.fn("ChatView.waitingApprovalCount")(function* (
	db: Executor,
	workspaceId: string,
	approver: ApproverStanding,
) {
	const asking = alias(placedChat, "asking_chat");
	const chat = alias(placedChat, "approval_chat");
	// Joined as the list joins it, so the count is of the calls it lists.
	const [counted] = yield* db
		.select({ waiting: sql<number>`count(*)::int` })
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.chatId))
		.innerJoin(chat, eq(chat.id, asking.rootChatId))
		.where(waitingOn(db, workspaceId, approver, asking));
	return counted?.waiting ?? 0;
});

/**
 * Whether a tool call, joined to the chat it asks in, `asking`, waits on a
 * decision the member `approver` describes may make, by the approver rule
 * `approvals.decide` checks, in a chat of the workspace.
 */
function waitingOn(
	db: Executor,
	workspaceId: string,
	approver: ApproverStanding,
	asking: AskingChat,
): SQL {
	const waitsIn = sql`${eq(asking.workspaceId, workspaceId)}
		and ${eq(toolCall.approvalStatus, "pending")}`;
	return pendingCallsApprovedBy(db, approver, asking, waitsIn);
}

function pendingCallsApprovedBy(
	db: Executor,
	approver: ApproverStanding,
	asking: AskingChat,
	waitsIn: SQL | undefined,
): SQL {
	const candidates = db
		.select({
			id: toolCall.id,
			turnId: toolCall.turnId,
			tool: toolCall.tool,
			approvalComputerProjectId: toolCall.approvalComputerProjectId,
		})
		.from(toolCall)
		.innerJoin(asking, eq(asking.id, toolCall.chatId))
		.where(waitsIn);
	return sql`${toolCall.id} in (${approvedCalls(approver, candidates)})`;
}

/**
 * The tool calls answered in chats `reachesChat` reaches, newest answer
 * first, each with the bot that asked and its chat.
 */
const answeredApprovalRows = Effect.fn("ChatView.answeredApprovalRows")(function* (
	db: Executor,
	workspaceId: string,
	reachesChat: ReachesChatSql,
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
 * `asking` is the chat a call was made in, and `chat` the one it belongs to.
 */
function selectApprovals(
	db: Executor,
	asking: AskingChat,
	chat: ApprovalChat,
	reachesChat = sql<boolean>`true`,
) {
	const approver = alias(member, "approver");
	const computerProject = alias(project, "approval_computer_project");
	return db
		.select({
			call: toolCall,
			reachesChat,
			projectId: listedProjectIdOf(chat),
			computerProject: { id: computerProject.id, name: computerProject.name },
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
		.leftJoin(computerProject, eq(computerProject.id, toolCall.approvalComputerProjectId))
		.$dynamic();
}

type AskingChat = ReturnType<typeof alias<typeof placedChat, "asking_chat">>;

/** The chat the asking chat belongs to. */
type ApprovalChat = ReturnType<typeof alias<typeof placedChat, "approval_chat">>;

type ApprovalRow = Effect.Success<ReturnType<typeof answeredApprovalRows>>[number];

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
	const call = toToolCallPart(row.call, row.decidedByName);
	return {
		call: row.reachesChat
			? call
			: {
					...call,
					input: fixedApprovalInput(row.call),
					output: null,
					error: null,
					atOffset: 0,
				},
		bot: { kind: "bot", ...row.bot },
		projectId: row.reachesChat ? row.projectId : (row.computerProject?.id ?? null),
		...(!row.reachesChat && row.computerProject && { projectName: row.computerProject.name }),
		chatId: row.reachesChat ? row.call.chatId : null,
		rootChatId: row.reachesChat ? row.rootChatId : null,
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

/** A member's standing as an approver, loaded when it is first needed. */
type LoadsApproverStanding = Effect.Effect<ApproverStanding, never, Database>;

/**
 * Those of `chatIds`, chats the member reaches, with a tool call waiting for
 * a decision they may make, by the approver rule `approvals.decide` checks.
 * Their standing, `approver`, is loaded only when a call waits in one.
 */
const chatsAwaitingDecisionBy = Effect.fn("ChatView.chatsAwaitingDecisionBy")(function* (
	approver: LoadsApproverStanding,
	chatIds: readonly string[],
) {
	if (chatIds.length === 0) return new Set<string>();
	const asking = alias(placedChat, "asking_chat");
	const waitsIn = and(
		inArray(asking.rootChatId, [...chatIds]),
		eq(toolCall.approvalStatus, "pending"),
	);
	const [waiting] = yield* query((db) =>
		db
			.select({ id: toolCall.id })
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.chatId))
			.where(waitsIn)
			.limit(1),
	);
	if (!waiting) return new Set<string>();
	const standing = yield* approver;
	const awaiting = yield* query((db) =>
		db
			.selectDistinct({ rootChatId: asking.rootChatId })
			.from(toolCall)
			.innerJoin(asking, eq(asking.id, toolCall.chatId))
			.where(pendingCallsApprovedBy(db, standing, asking, waitsIn)),
	);
	return new Set(awaiting.flatMap(({ rootChatId }) => (rootChatId ? [rootChatId] : [])));
});

/**
 * The project a chat is listed under, as `placedChat` or an
 * alias of it reads: a project members made. A bot's chat, in its default
 * project, is listed under the bot, so it has none.
 */
function listedProjectIdOf(row: { projectId: SQLWrapper; botId: SQLWrapper }): SQL<string | null> {
	return sql<string | null>`case when ${row.botId} is null then ${row.projectId} end`;
}

/** A chat as a list sorts it: by its newest message, or by when it began. */
interface ListedByLatest {
	readonly lastMessageAt: string | null;
	readonly chat: { readonly createdAt: string };
}

/** Newest message first; one nothing is written in yet by when it began. */
function byLatestMessage(left: ListedByLatest, right: ListedByLatest): number {
	const leftAt = left.lastMessageAt ?? left.chat.createdAt;
	const rightAt = right.lastMessageAt ?? right.chat.createdAt;
	return rightAt.localeCompare(leftAt);
}

/**
 * A page of the chat `inChat.chatId`, in its workspace: its messages with
 * their authors and parts, and its automation runs, each newest first and one
 * more than the page. Nothing when it is not a chat members open.
 */
const loadMessagesPage = Effect.fn("ChatView.loadMessagesPage")(function* (
	db: Executor,
	inChat: { chatId: string; workspaceId: string },
	limit: number,
	before: CursorPoint | undefined,
) {
	const { chatId } = inChat;
	const chat = yield* db.query.placedChat.findFirst({
		where: {
			id: chatId,
			workspaceId: inChat.workspaceId,
			kind: { in: [...OPENABLE_CHAT_KINDS] },
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
	const pauseAt = sql<Date | null>`coalesce(
		${automation.pausedAfterFailuresAt},
		${automation.pauseAfterFailuresPendingAt}
	)`.mapWith(automation.updatedAt);
	const [paused] = yield* db
		.select({ automationId: automation.id, at: pauseAt })
		.from(automation)
		.innerJoin(placedChat, eq(placedChat.automationId, automation.id))
		.where(and(eq(placedChat.id, chatId), before && earlierThan(pauseAt, automation.id, before)))
		.limit(1);
	const pausedAfterFailures = paused?.at
		? { automationId: paused.automationId, at: paused.at }
		: null;
	return { ...chat, automationRuns, pausedAfterFailures };
});

type LoadedMessagesPage = NonNullable<Effect.Success<ReturnType<typeof loadMessagesPage>>>;

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
function toMessagesPage(row: LoadedMessagesPage, limit: number) {
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
			.filter((run) => !run.posted)
			.map((run) => ({
				id: run.id,
				createdAt: run.acceptedAt,
				item: (): ChatMessageItem => ({
					kind: "run",
					id: run.id,
					chatId: run.chatId,
					automationName: run.automationName,
					triggerKind: run.triggerKind,
					state: run.state,
					error: run.error,
					// Only what the bot said after its last tool call, as a posted result would be.
					report: run.report && (textWithoutNarration(run.report.parts) || null),
					createdAt: run.acceptedAt.toISOString(),
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
 * A page of the chats opened beside the chat `inChat.chatId`, in its
 * workspace, one statement: its automation runs, each newest activity first
 * and one more than the page. Nothing when it is not a chat members open.
 */
const loadHistory = Effect.fn("ChatView.loadHistory")(function* (
	db: Executor,
	inChat: { chatId: string; workspaceId: string },
	limit: number,
	before: CursorPoint | undefined,
) {
	const items = {
		limit: limit + 1,
		orderBy: { updatedAt: "desc", id: "desc" },
		where: {
			kind: "run",
			...(before && { RAW: (row) => earlierThan(row.updatedAt, row.id, before) }),
		},
		with: {
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { member: memberColumns, bot: botColumns },
			},
			automationRun: {
				columns: { id: true, automationId: true, automationName: true, trigger: true, state: true },
			},
		},
	} satisfies DBQueryConfig<"many", typeof relations, (typeof relations)["placedChat"]>;
	return yield* db.query.placedChat.findFirst({
		where: {
			id: inChat.chatId,
			workspaceId: inChat.workspaceId,
			kind: { in: [...OPENABLE_CHAT_KINDS] },
		},
		columns: { id: true },
		with: { rootedChats: items },
	});
});

type HistoryRow = NonNullable<Effect.Success<ReturnType<typeof loadHistory>>>;

/** The runs, loaded newest activity first, cut to the page. */
function toHistoryPage(row: HistoryRow, limit: number) {
	const rooted = row.rootedChats;
	const page = rooted.slice(0, limit);
	// Every run's chat has its run's row.
	const items = page.flatMap(({ automationRun: run, ...side }): ChatHistoryEntry[] =>
		run
			? [
					{
						chatId: side.id,
						kind: "run",
						title: side.title,
						participants: side.participants.map(({ member: somebody, bot: participant }) =>
							toParticipant(authorRow(somebody, participant)),
						),
						status: run.state,
						automationRun: {
							runId: run.id,
							automationId: run.automationId,
							automationName: run.automationName,
							triggerKind: run.trigger.kind,
						},
					},
				]
			: [],
	);
	const oldest = page.at(-1);
	return {
		items,
		nextCursor:
			rooted.length > limit && oldest
				? encodeCursor({ at: oldest.updatedAt, id: oldest.id })
				: null,
	};
}

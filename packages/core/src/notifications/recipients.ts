import {
	type AutomationRunNotifications,
	chatNotificationTag,
	handleFromName,
	mentionedHandles,
	mentionsEveryone,
	type NotificationContent,
	type NotificationLevel,
	notifiesMembers,
	type QuietHours,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { type AnyColumn, and, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { reachesChatFor } from "../authorization/access.ts";
import { fixedApprovalInput } from "../chats/tools/approvers.ts";
import type { Executor } from "../database/database.ts";
import type { Audience } from "../database/events/audience.ts";
import {
	automation,
	automationRun,
	bot,
	chatParticipant,
	member,
	membership,
	message,
	notificationOverride,
	notificationSettings,
	placedChat,
	project,
	toolCall,
	turn,
	workspace,
} from "../database/schema.ts";
import { approvalAudience } from "../proofs/approvers.ts";
import { approvalPath, chatPath } from "../server-settings/web-app-paths.ts";

/**
 * Who is notified of what, decided as Slack decides it: by why the member
 * would care (they were mentioned, a bot replied to them or failed to, they
 * take part in the chat, it waits on their approval, an automation of
 * theirs ran, or it is just activity), by the level they chose for the bot it
 * is about, else its project, else themselves, and never while they are paused or
 * in their quiet hours. Their tabs hold back what they are looking at.
 */

/** A notification for one member. */
export interface Addressed {
	memberId: string;
	notification: NotificationContent;
	/** The call waiting for approval that the notification asks the member to decide, if it asks one. */
	approvalCallId?: string;
}

/** Why a member would want to hear of something. */
export type Reason =
	| "mention"
	| "reply"
	| "failure"
	| "participant"
	| "approval"
	| "automation"
	| "activity";

/** The level a member has before choosing one: mentions, and what else concerns them. */
export const DEFAULT_LEVEL: NotificationLevel = "mentions";

/** Whether a member hears of a bot's reply to them failing, before they choose. */
export const DEFAULT_TURN_FAILURES = true;

/** Which of a member's automations' runs they hear the end of, before they choose. */
export const DEFAULT_AUTOMATION_RUNS: AutomationRunNotifications = "failures";

/** Whether somebody at `level` hears of something they would care about for `reason`. */
function levelAdmits(level: NotificationLevel, reason: Reason): boolean {
	switch (level) {
		case "all":
			return true;
		case "mentions":
			return reason !== "activity";
		case "nothing":
			return false;
	}
}

/** Whether `at` falls in `quietHours`, read on a wall clock in their time zone. */
function inQuietHours(quietHours: QuietHours, at: Date): boolean {
	const from = minutesOfDay(quietHours.from);
	const to = minutesOfDay(quietHours.to);
	if (from === to) return false;
	const [hour = "0", minute = "0"] = new Intl.DateTimeFormat("en-GB", {
		timeZone: quietHours.timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	})
		.format(at)
		.split(":");
	const now = Number(hour) * 60 + Number(minute);
	return from < to ? now >= from && now < to : now >= from || now < to;
}

function minutesOfDay(time: string): number {
	const [hour = 0, minute = 0] = time.split(":").map(Number);
	return hour * 60 + minute;
}

/**
 * A finished message somebody wrote in a project's chat, a bot's included,
 * or an automation's result posted in its automation's feed.
 */
export interface WrittenMessage {
	chatId: string;
	messageId: string;
	author:
		| { kind: "member"; memberId: string }
		| { kind: "bot"; botId: string }
		| { kind: "automation" };
	authorName: string;
	content: string;
	/** The names of the files it shares, which stand in for its text when it has none. */
	fileNames: readonly string[];
	/** The titles of the files an automation's result shows, which stand in for its text when it has none. */
	fileTitles: readonly string[];
	/** The member whose message it answers, who hears of it as of a reply in Slack. */
	repliesTo: string | null;
	/** The chat of the automation run it is the result of, when it is one. */
	resultOf: { chatId: string } | null;
}

/**
 * The notifications a finished message sends. Only chats, a bot's or a
 * project's, notify: automation runs and system bots' chats are bots' work, which reaches members through what they post in
 * those. An automation's result in its automation's feed notifies those it mentions,
 * which is how its bot asks for somebody.
 */
export const forMessage = Effect.fn("Notifications.forMessage")(function* (
	db: Executor,
	written: WrittenMessage,
	now: Date,
) {
	const preview =
		previewOf(written.content) ||
		sharedPreview(written.fileNames) ||
		sharedPreview(written.fileTitles);
	if (!preview) return [];
	const place = yield* placeOf(db, written.chatId);
	if (!place) return [];
	const automationResult = place.kind === "automation_feed" ? written.resultOf : null;
	if (!automationResult && !notifiesMembers(place.kind)) return [];
	const mentioned = new Set(mentionedHandles(written.content));
	const { author, authorName } = written;
	// Only a member's `@here` or `@channel`: a bot's would let whatever it read or was asked to say page the whole project.
	const addressesEveryone = author.kind === "member" && mentionsEveryone(written.content);
	// A bot's chat, in its default project, is that bot's; in a project's chat, what a bot posts is.
	const botId = place.botId ?? (author.kind === "bot" ? author.botId : null);
	const reaching = yield* membersReaching(db, place, botId, now);
	return reaching.flatMap((member): Addressed[] => {
		if (author.kind === "member" && member.id === author.memberId) return [];
		const reason: Reason =
			addressesEveryone || mentioned.has(handleFromName(member.name))
				? "mention"
				: member.id === written.repliesTo
					? "reply"
					: member.participant
						? "participant"
						: "activity";
		if (automationResult && reason !== "mention") return [];
		if (!wants(member, reason, now)) return [];
		return [
			{
				memberId: member.id,
				notification: {
					title:
						reason === "mention"
							? `${authorName} mentioned you in ${place.title}`
							: `${authorName} in ${place.title}`,
					body: preview,
					tag: chatNotificationTag(place.rootChatId),
					path: chatPath(
						place,
						place.rootChatId,
						automationResult
							? { runChat: automationResult.chatId }
							: { message: written.messageId },
					),
					chatId: place.rootChatId,
				},
			},
		];
	});
});

/** The notifications a bot's finished reply sends, as a reply to the member whose message it answers. */
export const forReply = Effect.fn("Notifications.forReply")(function* (
	db: Executor,
	completed: { chatId: string; turnId: string; messageId: string; content: string },
	now: Date,
) {
	const answering = yield* answeredBy(db, completed.turnId);
	if (!answering) return [];
	return yield* forMessage(
		db,
		{
			chatId: completed.chatId,
			messageId: completed.messageId,
			author: { kind: "bot", botId: answering.botId },
			authorName: answering.botName,
			content: completed.content,
			fileNames: [],
			fileTitles: [],
			repliesTo: answering.memberId,
			resultOf: null,
		},
		now,
	);
});

/** The bot taking the turn, and the member whose message it answers, when a member wrote it. */
const answeredBy = Effect.fn("Notifications.answeredBy")(function* (db: Executor, turnId: string) {
	const [answering] = yield* db
		.select({ memberId: message.authorMemberId, botId: bot.id, botName: bot.name })
		.from(turn)
		.innerJoin(bot, eq(bot.id, turn.botId))
		.innerJoin(message, eq(message.id, turn.triggerMessageId))
		.where(eq(turn.id, turnId));
	return answering;
});

/**
 * The notifications a turn waiting for approvals sends: to each member who
 * may decide one, naming and linking to only the calls they may decide.
 */
export const forApprovals = Effect.fn("Notifications.forApprovals")(function* (
	db: Executor,
	waiting: {
		chatId: string;
		turnId: string;
		approvalCallIds: readonly string[];
		approvalIds?: readonly string[];
	},
	now: Date,
) {
	const place = yield* placeOf(db, waiting.chatId);
	if (!place) return [];
	const calls = yield* db
		.select({ id: toolCall.id, tool: toolCall.tool, botId: bot.id, botName: bot.name })
		.from(toolCall)
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(bot, eq(bot.id, turn.botId))
		.where(
			and(
				eq(toolCall.turnId, waiting.turnId),
				eq(toolCall.approvalStatus, "pending"),
				inArray(toolCall.id, waiting.approvalCallIds),
				waiting.approvalIds ? inArray(toolCall.approvalId, waiting.approvalIds) : undefined,
			),
		)
		.orderBy(toolCall.startedAt, toolCall.id);
	const [first] = calls;
	if (!first) return [];
	const audience = yield* approvalAudience(
		db,
		calls.map(({ id }) => id),
	);
	if (audience.length === 0) return [];
	const preferences = yield* membersReaching(
		db,
		place,
		first.botId,
		now,
		audience.map(({ memberId }) => memberId),
	);
	const addressed: Addressed[] = [];
	for (const { memberId, reachesChat, calls: decidable } of audience) {
		const member = preferences.find(({ id }) => id === memberId);
		if (!member || !wants(member, "approval", now)) continue;
		const [firstDecidable] = decidable;
		if (!firstDecidable) continue;
		const fixedInput = fixedApprovalInput(firstDecidable);
		const host =
			fixedInput && typeof fixedInput === "object" && "host" in fixedInput
				? fixedInput.host
				: undefined;
		const description = decidable.length === 1 ? firstDecidable.tool : `${decidable.length} tools`;
		addressed.push({
			memberId,
			approvalCallId: firstDecidable.id,
			notification: {
				title: `${first.botName} needs your approval`,
				body: reachesChat
					? `To run ${description} in ${place.title}`
					: typeof host === "string"
						? `To let its computer reach ${host}`
						: `To run ${description}`,
				tag: `approval:${waiting.turnId}`,
				path: approvalPath(place.workspaceSlug, firstDecidable.id),
				chatId: reachesChat ? place.rootChatId : null,
			},
		});
	}
	return addressed;
});

/**
 * The notification a bot's reply failing sends, to the member whose message
 * it was answering, unless the turn will run again.
 */
export const forFailedReply = Effect.fn("Notifications.forFailedReply")(function* (
	db: Executor,
	failed: { chatId: string; turnId: string; messageId: string; userMessage: UserText },
	now: Date,
) {
	const place = yield* placeOf(db, failed.chatId);
	if (!place || !notifiesMembers(place.kind)) return [];
	const answering = yield* answeredBy(db, failed.turnId);
	if (!answering?.memberId) return [];
	const reaching = yield* membersReaching(db, place, place.botId ?? answering.botId, now);
	return reaching
		.filter(
			(member) =>
				member.id === answering.memberId &&
				(member.turnFailures ?? DEFAULT_TURN_FAILURES) &&
				wants(member, "failure", now),
		)
		.map(
			(member): Addressed => ({
				memberId: member.id,
				notification: {
					title: `${answering.botName} couldn't finish its reply`,
					body: failed.userMessage,
					tag: chatNotificationTag(place.rootChatId),
					path: chatPath(place, place.rootChatId, { message: failed.messageId }),
					chatId: place.rootChatId,
				},
			}),
		);
});

/**
 * The notifications an automation run ending sends: to the member who made the
 * automation and the member who started the run, as they chose to hear of its
 * runs. A cancelled run sends none, since somebody stopped it on purpose.
 */
export const forAutomationRun = Effect.fn("Notifications.forAutomationRun")(function* (
	db: Executor,
	settled: { chatId: string; rootChatId: string },
	now: Date,
) {
	const [run] = yield* db
		.select({
			state: automationRun.state,
			error: automationRun.error,
			trigger: automationRun.trigger,
			automationName: automationRun.automationName,
			botId: automationRun.botId,
			botName: bot.name,
			createdById: automation.createdById,
		})
		.from(automationRun)
		.innerJoin(automation, eq(automation.id, automationRun.automationId))
		.innerJoin(bot, eq(bot.id, automationRun.botId))
		.where(eq(automationRun.chatId, settled.chatId));
	if (!run || (run.state !== "completed" && run.state !== "failed")) return [];
	const failed = run.state === "failed";
	const place = yield* placeOf(db, settled.chatId);
	if (!place) return [];
	const owners = new Set([
		run.createdById,
		run.trigger.kind === "manual" ? run.trigger.requestedByMemberId : null,
	]);
	const reaching = yield* membersReaching(db, place, run.botId, now);
	return reaching
		.filter((member) => {
			if (!owners.has(member.id)) return false;
			const chosen = member.automationRuns ?? DEFAULT_AUTOMATION_RUNS;
			const hears = chosen === "all" || (chosen === "failures" && failed);
			return hears && wants(member, "automation", now);
		})
		.map(
			(member): Addressed => ({
				memberId: member.id,
				notification: {
					title: failed ? `${run.automationName} failed` : `${run.automationName} finished`,
					body: failed
						? (run.error ?? `${run.botName}'s run didn't finish.`)
						: `${run.botName} finished the run.`,
					tag: `automation:${settled.chatId}`,
					path: chatPath(place, settled.rootChatId, { runChat: settled.chatId }),
					chatId: settled.rootChatId,
				},
			}),
		);
});

/** The most of a message a notification shows. */
const PREVIEW_CHARACTERS = 180;

function previewOf(content: string): string {
	const flat = content.replace(/\s+/g, " ").trim();
	// By code point, so an emoji is never cut in half.
	const characters = [...flat];
	return characters.length > PREVIEW_CHARACTERS
		? `${characters.slice(0, PREVIEW_CHARACTERS - 1).join("")}…`
		: flat;
}

function sharedPreview(names: readonly string[]): string {
	if (names.length === 0) return "";
	return names.length === 1 ? `Shared ${names[0]}` : `Shared ${names.length} files`;
}

/**
 * Whether `memberId` may still be told a notification for `audience`, read
 * now in the caller's transaction: they reach its chat, or, for an approval,
 * they can still decide the call and reach its chat when the notification
 * shows the chat. A notification for no chat or approval, such as a test,
 * needs neither.
 */
export const mayStillBeTold = Effect.fn("Notifications.mayStillBeTold")(function* (
	db: Executor,
	memberId: string,
	audience: Audience.Group | undefined,
) {
	if (audience?.kind === "approval") {
		const approvers = yield* approvalAudience(db, [audience.toolCall]);
		return approvers.some(
			(approver) => approver.memberId === memberId && (approver.reachesChat || !audience.showsChat),
		);
	}
	if (audience?.kind !== "chat") return true;
	const [reaching] = yield* db
		.select({ id: member.id })
		.from(member)
		.innerJoin(placedChat, eq(placedChat.id, audience.chat))
		.where(
			and(
				eq(member.id, memberId),
				isNotNull(placedChat.projectId),
				reachesChatFor({ projectId: placedChat.projectId }, member.id),
			),
		)
		.limit(1);
	return reaching !== undefined;
});

type Place = NonNullable<Effect.Success<ReturnType<typeof placeOf>>>;

/** The chat, the one it is in, and the addresses of its workspace and project, if it has one. */
const placeOf = Effect.fn("Notifications.placeOf")(function* (db: Executor, chatId: string) {
	const chat = alias(placedChat, "chat");
	const [row] = yield* db
		.select({
			kind: placedChat.kind,
			projectId: placedChat.projectId,
			botId: placedChat.botId,
			workspaceId: placedChat.workspaceId,
			rootChatId: sql<string>`coalesce(${placedChat.rootChatId}, ${placedChat.id})`,
			title: sql<string>`coalesce(${chat.title}, ${placedChat.title})`,
			/** Null outside a project members made: a bot's chat is reached through the bot. */
			projectSlug: project.slug,
			workspaceSlug: workspace.slug,
		})
		.from(placedChat)
		.leftJoin(chat, eq(chat.id, placedChat.rootChatId))
		.leftJoin(project, and(eq(project.id, placedChat.projectId), isNull(project.defaultOfBotId)))
		.innerJoin(workspace, eq(workspace.id, placedChat.workspaceId))
		.where(eq(placedChat.id, chatId))
		.limit(1);
	return row;
});

type Member = Effect.Success<ReturnType<typeof membersReaching>>[number];

/**
 * Everybody who reaches the place, with the level they chose for `botId`, the
 * bot it is about, else for the project, else their own: the members who
 * reach the chat.
 */
const membersReaching = Effect.fn("Notifications.membersReaching")(function* (
	db: Executor,
	place: Place,
	botId: string | null,
	now: Date,
	approvalRecipients?: readonly string[],
) {
	const botLevel = alias(notificationOverride, "bot_level");
	const projectLevel = alias(notificationOverride, "project_level");
	return yield* db
		.select({
			id: member.id,
			name: member.name,
			participant: exists(
				sql`select 1 from ${chatParticipant} where ${chatParticipant.chatId} = ${place.rootChatId} and ${chatParticipant.memberId} = ${member.id}`,
			),
			// A project muted for a while quiets every bot in it, whatever level the bot has.
			level: sql<NotificationLevel | null>`coalesce(${mutedOf(projectLevel, now)}, ${mutedOf(botLevel, now)}, ${botLevel.level}, ${projectLevel.level}, ${notificationSettings.level})`,
			pausedUntil: notificationSettings.pausedUntil,
			quietHours: notificationSettings.quietHours,
			turnFailures: notificationSettings.turnFailures,
			automationRuns: notificationSettings.automationRuns,
		})
		.from(membership)
		.innerJoin(member, eq(member.id, membership.memberId))
		.leftJoin(notificationSettings, eq(notificationSettings.memberId, member.id))
		.leftJoin(
			botLevel,
			and(
				eq(botLevel.memberId, member.id),
				botId === null ? sql`false` : eq(botLevel.botId, botId),
			),
		)
		.leftJoin(
			projectLevel,
			and(
				eq(projectLevel.memberId, member.id),
				place.projectId === null ? sql`false` : eq(projectLevel.projectId, place.projectId),
			),
		)
		.where(
			and(
				eq(membership.workspaceId, place.workspaceId),
				approvalRecipients
					? inArray(member.id, approvalRecipients)
					: reachesChatFor({ projectId: sql`${place.projectId}::uuid` }, member.id),
			),
		);
});

/** `nothing` while `override` is muted, else null. */
function mutedOf(override: { mutedUntil: AnyColumn }, now: Date): SQL<NotificationLevel | null> {
	return sql`case when ${override.mutedUntil} > ${now} then 'nothing' end`;
}

function exists(subquery: SQL): SQL<boolean> {
	return sql<boolean>`exists (${subquery})`;
}

/** Whether `member` would be notified now of something they care about for `reason`. */
function wants(member: Member, reason: Reason, now: Date): boolean {
	if (member.pausedUntil && member.pausedUntil > now) return false;
	if (member.quietHours && inQuietHours(member.quietHours, now)) return false;
	return levelAdmits(member.level ?? DEFAULT_LEVEL, reason);
}

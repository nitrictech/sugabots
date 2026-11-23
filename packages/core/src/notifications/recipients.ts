import {
	type AutomationRunNotifications,
	chatNotificationTag,
	handleFromName,
	mentionedHandles,
	mentionsEveryone,
	type NotificationContent,
	type NotificationLevel,
	notifiesPeople,
	type QuietHours,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { type AnyColumn, and, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
	chatStandingFor,
	computerProjectStandingFor,
	mayDecideToolCall,
	reachesChatFor,
} from "../authorization/access.ts";
import type { BotFacts } from "../authorization/permissions.ts";
import { findRunBot } from "../chats/automations/execution.ts";
import { approversOf } from "../chats/tools/approvers.ts";
import type { Executor } from "../database/database.ts";
import {
	automation,
	automationRun,
	bot,
	chatParticipant,
	membership,
	message,
	notificationOverride,
	notificationSettings,
	person,
	placedChat,
	project,
	toolCall,
	turn,
	workspace,
} from "../database/schema.ts";
import { approvalPath, chatPath } from "../server-settings/web-app-paths.ts";

/**
 * Who is notified of what, decided as Slack decides it: by why the person
 * would care (they were mentioned, a bot replied to them or failed to, they
 * take part in the chat, it waits on their approval, an automation of
 * theirs ran, or it is just activity), by the level they chose for the bot it
 * is about, else its project, else themselves, and never while they are paused or
 * in their quiet hours. Their tabs hold back what they are looking at.
 */

/** A notification for one person. */
export interface Addressed {
	personId: string;
	notification: NotificationContent;
}

/** Why a person would want to hear of something. */
export type Reason =
	| "mention"
	| "reply"
	| "failure"
	| "participant"
	| "approval"
	| "automation"
	| "activity";

/** The level a person has before choosing one: mentions, and what else concerns them. */
export const DEFAULT_LEVEL: NotificationLevel = "mentions";

/** Whether a person hears of a bot's reply to them failing, before they choose. */
export const DEFAULT_TURN_FAILURES = true;

/** Which of a person's automations' runs they hear the end of, before they choose. */
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
export function inQuietHours(quietHours: QuietHours, at: Date): boolean {
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
interface WrittenMessage {
	chatId: string;
	messageId: string;
	author:
		| { kind: "person"; personId: string }
		| { kind: "bot"; botId: string }
		| { kind: "automation" };
	authorName: string;
	content: string;
	/** The names of the files it shares, which stand in for its text when it has none. */
	fileNames: readonly string[];
	/** The titles of the files an automation's result shows, which stand in for its text when it has none. */
	fileTitles: readonly string[];
	/** The person whose message it answers, who hears of it as of a reply in Slack. */
	repliesTo: string | null;
	/** The automation run it is the result of, and that run's own chat, when it is one. */
	resultOf: { runId: string; chatId: string } | null;
}

/**
 * The notifications a finished message sends. Only chats, a bot's or a
 * project's, notify: automation runs, collaborations and system bots'
 * chats are bots' work, which reaches people through what they post in
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
	if (!automationResult && !notifiesPeople(place.kind)) return [];
	if (automationResult && (yield* postedElsewhere(db, automationResult.runId, written.chatId))) {
		return [];
	}
	const mentioned = new Set(mentionedHandles(written.content));
	const { author, authorName } = written;
	// Only a person's `@here` or `@channel`: a bot's would let whatever it read or was asked to say page the whole project.
	const addressesEveryone = author.kind === "person" && mentionsEveryone(written.content);
	// A bot's chat, in its default project, is that bot's; in a project's chat, what a bot posts is.
	const botId = place.botId ?? (author.kind === "bot" ? author.botId : null);
	const reaching = yield* peopleReaching(db, place, botId, now);
	return reaching.flatMap((person): Addressed[] => {
		if (author.kind === "person" && person.id === author.personId) return [];
		const reason: Reason =
			addressesEveryone || mentioned.has(handleFromName(person.name))
				? "mention"
				: person.id === written.repliesTo
					? "reply"
					: person.participant
						? "participant"
						: "activity";
		if (automationResult && reason !== "mention") return [];
		if (!wants(person, reason, now)) return [];
		return [
			{
				personId: person.id,
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
							? { nestedChatPage: automationResult.chatId }
							: { message: written.messageId },
					),
					chatId: place.rootChatId,
				},
			},
		];
	});
});

/** Whether the run `runId` posted its result in a chat besides `chatId`. */
const postedElsewhere = Effect.fn("Notifications.postedElsewhere")(function* (
	db: Executor,
	runId: string,
	chatId: string,
) {
	const [elsewhere] = yield* db
		.select({ id: message.id })
		.from(message)
		.where(and(eq(message.runId, runId), ne(message.chatId, chatId)))
		.limit(1);
	return elsewhere !== undefined;
});

/** The notifications a bot's finished reply sends, as a reply to the person whose message it answers. */
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
			repliesTo: answering.personId,
			resultOf: null,
		},
		now,
	);
});

/** The bot taking the turn, and the person whose message it answers, when a person wrote it. */
const answeredBy = Effect.fn("Notifications.answeredBy")(function* (db: Executor, turnId: string) {
	const [answering] = yield* db
		.select({ personId: message.authorPersonId, botId: bot.id, botName: bot.name })
		.from(turn)
		.innerJoin(bot, eq(bot.id, turn.botId))
		.innerJoin(message, eq(message.id, turn.triggerMessageId))
		.where(eq(turn.id, turnId));
	return answering;
});

/**
 * The notifications a turn waiting for approvals sends: to each person who
 * may decide one, naming and linking to only the calls they may decide.
 */
export const forApprovals = Effect.fn("Notifications.forApprovals")(function* (
	db: Executor,
	waiting: { chatId: string; turnId: string },
	now: Date,
) {
	const place = yield* placeOf(db, waiting.chatId);
	if (!place) return [];
	const calls = yield* db
		.select({ id: toolCall.id, tool: toolCall.tool, botId: bot.id, botName: bot.name })
		.from(toolCall)
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(bot, eq(bot.id, turn.botId))
		.where(and(eq(toolCall.turnId, waiting.turnId), eq(toolCall.approvalStatus, "pending")))
		.orderBy(toolCall.startedAt);
	const [first] = calls;
	if (!first) return [];
	const runBot = yield* findRunBot(db, waiting.chatId);
	const reaching = yield* peopleReaching(db, place, first.botId, now);
	const addressed: Addressed[] = [];
	for (const person of reaching) {
		if (!wants(person, "approval", now)) continue;
		const decidable = yield* callsDecidableBy(db, waiting.chatId, person.id, calls, {
			turnBotId: first.botId,
			runBot,
		});
		const [firstDecidable] = decidable;
		if (!firstDecidable) continue;
		addressed.push({
			personId: person.id,
			notification: {
				title: `${first.botName} needs your approval`,
				body:
					decidable.length === 1
						? `To run ${firstDecidable.tool} in ${place.title}`
						: `To run ${decidable.length} tools in ${place.title}`,
				tag: `approval:${waiting.turnId}`,
				path: approvalPath(place.workspaceSlug, firstDecidable.id),
				chatId: place.rootChatId,
			},
		});
	}
	return addressed;
});

/**
 * The notification a bot's reply failing sends, to the person whose message
 * it was answering, unless the turn will run again.
 */
export const forFailedReply = Effect.fn("Notifications.forFailedReply")(function* (
	db: Executor,
	failed: { chatId: string; turnId: string; messageId: string; userMessage: UserText },
	now: Date,
) {
	const place = yield* placeOf(db, failed.chatId);
	if (!place || !notifiesPeople(place.kind)) return [];
	const answering = yield* answeredBy(db, failed.turnId);
	if (!answering?.personId) return [];
	const reaching = yield* peopleReaching(db, place, place.botId ?? answering.botId, now);
	return reaching
		.filter(
			(person) =>
				person.id === answering.personId &&
				(person.turnFailures ?? DEFAULT_TURN_FAILURES) &&
				wants(person, "failure", now),
		)
		.map(
			(person): Addressed => ({
				personId: person.id,
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
 * The notifications an automation run ending sends: to the person who made the
 * automation and the person who started the run, as they chose to hear of its
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
		run.trigger.kind === "manual" ? run.trigger.requestedByPersonId : null,
	]);
	const reaching = yield* peopleReaching(db, place, run.botId, now);
	return reaching
		.filter((person) => {
			if (!owners.has(person.id)) return false;
			const chosen = person.automationRuns ?? DEFAULT_AUTOMATION_RUNS;
			const hears = chosen === "all" || (chosen === "failures" && failed);
			return hears && wants(person, "automation", now);
		})
		.map(
			(person): Addressed => ({
				personId: person.id,
				notification: {
					title: failed ? `${run.automationName} failed` : `${run.automationName} finished`,
					body: failed
						? (run.error ?? `${run.botName}'s run didn't finish.`)
						: `${run.botName} finished the run.`,
					tag: `automation:${settled.chatId}`,
					path: chatPath(place, settled.rootChatId, {
						nestedChatPage: settled.chatId,
					}),
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

type Place = NonNullable<Effect.Success<ReturnType<typeof placeOf>>>;

/** The chat, the one it is in, and the addresses of its workspace and project, if it has one. */
const placeOf = Effect.fn("Notifications.placeOf")(function* (db: Executor, chatId: string) {
	const chat = alias(placedChat, "chat");
	const [row] = yield* db
		.select({
			kind: placedChat.kind,
			/** A collaboration's is the project of the chat it was opened from. */
			projectId: sql<string | null>`coalesce(${chat.projectId}, ${placedChat.projectId})`,
			botId: placedChat.botId,
			workspaceId: placedChat.workspaceId,
			rootChatId: sql<string>`coalesce(${placedChat.rootChatId}, ${placedChat.id})`,
			title: sql<string>`coalesce(${chat.title}, ${placedChat.title})`,
			/** Null outside a project people made: a bot's chat is reached through the bot. */
			projectSlug: project.slug,
			workspaceSlug: workspace.slug,
		})
		.from(placedChat)
		.leftJoin(chat, eq(chat.id, placedChat.rootChatId))
		.leftJoin(
			project,
			and(
				eq(project.id, sql`coalesce(${chat.projectId}, ${placedChat.projectId})`),
				isNull(project.defaultOfBotId),
			),
		)
		.innerJoin(workspace, eq(workspace.id, placedChat.workspaceId))
		.where(eq(placedChat.id, chatId))
		.limit(1);
	return row;
});

type Person = Effect.Success<ReturnType<typeof peopleReaching>>[number];

/**
 * Everybody who reaches the place, with the level they chose for `botId`, the
 * bot it is about, else for the project, else their own: the people who
 * reach the chat.
 */
const peopleReaching = Effect.fn("Notifications.peopleReaching")(function* (
	db: Executor,
	place: Place,
	botId: string | null,
	now: Date,
) {
	const botLevel = alias(notificationOverride, "bot_level");
	const projectLevel = alias(notificationOverride, "project_level");
	return yield* db
		.select({
			id: person.id,
			name: person.name,
			participant: exists(
				sql`select 1 from ${chatParticipant} where ${chatParticipant.chatId} = ${place.rootChatId} and ${chatParticipant.personId} = ${person.id}`,
			),
			// A project muted for a while quiets every bot in it, whatever level the bot has.
			level: sql<NotificationLevel | null>`coalesce(${mutedOf(projectLevel, now)}, ${mutedOf(botLevel, now)}, ${botLevel.level}, ${projectLevel.level}, ${notificationSettings.level})`,
			pausedUntil: notificationSettings.pausedUntil,
			quietHours: notificationSettings.quietHours,
			turnFailures: notificationSettings.turnFailures,
			automationRuns: notificationSettings.automationRuns,
		})
		.from(membership)
		.innerJoin(person, eq(person.id, membership.personId))
		.leftJoin(notificationSettings, eq(notificationSettings.personId, person.id))
		.leftJoin(
			botLevel,
			and(
				eq(botLevel.personId, person.id),
				botId === null ? sql`false` : eq(botLevel.botId, botId),
			),
		)
		.leftJoin(
			projectLevel,
			and(
				eq(projectLevel.personId, person.id),
				place.projectId === null ? sql`false` : eq(projectLevel.projectId, place.projectId),
			),
		)
		.where(
			and(
				eq(membership.workspaceId, place.workspaceId),
				reachesChatFor(
					{
						kind: sql`${place.kind}`,
						rootChatId: sql`${place.rootChatId}::uuid`,
						projectId: sql`${place.projectId}::uuid`,
					},
					person.id,
				),
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

/** Whether `person` would be notified now of something they care about for `reason`. */
function wants(person: Person, reason: Reason, now: Date): boolean {
	if (person.pausedUntil && person.pausedUntil > now) return false;
	if (person.quietHours && inQuietHours(person.quietHours, now)) return false;
	return levelAdmits(person.level ?? DEFAULT_LEVEL, reason);
}

/**
 * The calls among `calls`, all raised by one turn of `turnBotId`, in the
 * run `runBot` does if any, that `personId` may decide, in their order:
 * none unless they reach the chat, then each that `mayDecideToolCall`
 * lets them decide. Their
 * standing in the computer's project is loaded only when a call asks to
 * change the computer.
 */
const callsDecidableBy = Effect.fn("Notifications.callsDecidableBy")(function* (
	db: Executor,
	chatId: string,
	personId: string,
	calls: ReadonlyArray<PendingCall>,
	turn: { turnBotId: string; runBot: BotFacts | undefined },
) {
	const reached = yield* chatStandingFor(db, chatId, personId);
	if (!reached) return [];
	const asksForComputer = calls.some((call) => approversOf(call.tool) === "computer-managers");
	const computerProject = asksForComputer
		? yield* computerProjectStandingFor(db, chatId, turn.turnBotId, personId)
		: undefined;
	return calls.filter((call) =>
		mayDecideToolCall(reached.standing, computerProject, turn.runBot, approversOf(call.tool)),
	);
});

/** A tool call waiting for approval, as an approval notification names it. */
interface PendingCall {
	id: string;
	tool: string;
}

import {
	type AutomationRunNotifications,
	conversationNotificationTag,
	handleFromName,
	mentionedHandles,
	mentionsEveryone,
	NOTIFYING_CONVERSATION_KINDS,
	type NotificationContent,
	type NotificationLevel,
	type QuietHours,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { type AnyColumn, and, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
	computerProjectStandingFor,
	conversationStandingFor,
	mayDecideToolCall,
	reachesConversationFor,
} from "../authorization/access.ts";
import { findRunId } from "../conversations/automations/execution.ts";
import { membersOfDirectKey } from "../conversations/repository/repository.ts";
import { decidersOf } from "../conversations/tools/approval-deciders.ts";
import type { Executor } from "../database/database.ts";
import {
	automation,
	automationRun,
	bot,
	conversationParticipant,
	message,
	notificationOverride,
	notificationSettings,
	placedConversation,
	project,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { conversationPath } from "../installation/web-app-paths.ts";

/**
 * Who is notified of what, decided as Slack decides it: by why the person
 * would care (they were mentioned, a bot replied to them or failed to, they
 * take part in the conversation, it waits on their approval, an automation of
 * theirs ran, or it is just activity), by the level they chose for the bot it
 * is about, else its project, else themselves, and never while they are paused or
 * in their quiet hours. Their tabs hold back what they are looking at.
 */

/** A notification for one person. */
export interface Addressed {
	userId: string;
	notification: NotificationContent;
}

/** Why a person would want to hear of something. */
export type Reason =
	| "mention"
	/** It is a direct message to them, which Slack's "mentions" level lets through. */
	| "direct"
	| "reply"
	| "failure"
	| "participant"
	| "approval"
	| "automation"
	| "activity";

/** The level a person has before choosing one: Slack's "mentions and direct messages". */
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

/** A finished message somebody wrote in a project's thread, a bot's included, or a direct message. */
interface WrittenMessage {
	conversationId: string;
	messageId: string;
	author:
		| { kind: "person"; userId: string }
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
	/** The automation run it is the result of, and that run's own conversation, when it is one. */
	resultOf: { runId: string; conversationId: string } | null;
}

/**
 * The notifications a finished message sends. Only threads, a bot's or a project's, and
 * direct messages notify: automation runs, collaborations and system bots'
 * conversations are bots' work, which reaches people through what they post in
 * those. A direct message notifies the person it is to as a mention would. An
 * automation's result in its automation's feed notifies those it mentions,
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
	const place = yield* placeOf(db, written.conversationId);
	if (!place) return [];
	const automationResult = place.kind === "automation_feed" ? written.resultOf : null;
	if (!automationResult && !NOTIFYING_CONVERSATION_KINDS.has(place.kind)) return [];
	if (
		automationResult &&
		(yield* postedElsewhere(db, automationResult.runId, written.conversationId))
	) {
		return [];
	}
	const mentioned = new Set(mentionedHandles(written.content));
	const { author, authorName } = written;
	// Only a person's `@here` or `@channel`: a bot's would let whatever it read or was asked to say page the whole project.
	const addressesEveryone = author.kind === "person" && mentionsEveryone(written.content);
	// A bot's thread, in its default project, is that bot's; in a project's thread, what a bot posts is.
	const botId = place.botId ?? (author.kind === "bot" ? author.botId : null);
	const audience = yield* audienceOf(db, place, botId, now);
	return audience.flatMap((person): Addressed[] => {
		if (author.kind === "person" && person.id === author.userId) return [];
		const reason: Reason =
			place.kind === "direct_message"
				? "direct"
				: addressesEveryone || mentioned.has(handleFromName(person.name))
					? "mention"
					: person.id === written.repliesTo
						? "reply"
						: person.participant && place.kind === "project_thread"
							? "participant"
							: "activity";
		if (automationResult && reason !== "mention") return [];
		if (!wants(person, reason, now)) return [];
		const where = whereFrom(place);
		return [
			{
				userId: person.id,
				notification: {
					title:
						reason === "mention" ? `${authorName} mentioned you${where}` : `${authorName}${where}`,
					body: preview,
					tag: conversationNotificationTag(place.rootConversationId),
					path: conversationPath(
						place,
						place.rootConversationId,
						automationResult
							? { itemPage: automationResult.conversationId }
							: { message: written.messageId },
					),
					conversationId: place.rootConversationId,
				},
			},
		];
	});
});

/** Whether the run `runId` posted its result in a conversation besides `conversationId`. */
const postedElsewhere = Effect.fn("Notifications.postedElsewhere")(function* (
	db: Executor,
	runId: string,
	conversationId: string,
) {
	const [elsewhere] = yield* db
		.select({ id: message.id })
		.from(message)
		.where(and(eq(message.runId, runId), ne(message.conversationId, conversationId)))
		.limit(1);
	return elsewhere !== undefined;
});

/** The notifications a bot's finished reply sends, as a reply to the person whose message it answers. */
export const forReply = Effect.fn("Notifications.forReply")(function* (
	db: Executor,
	completed: { conversationId: string; turnId: string; messageId: string; content: string },
	now: Date,
) {
	const answering = yield* answeredBy(db, completed.turnId);
	if (!answering) return [];
	return yield* forMessage(
		db,
		{
			conversationId: completed.conversationId,
			messageId: completed.messageId,
			author: { kind: "bot", botId: answering.botId },
			authorName: answering.botName,
			content: completed.content,
			fileNames: [],
			fileTitles: [],
			repliesTo: answering.userId,
			resultOf: null,
		},
		now,
	);
});

/** The bot taking the turn, and the person whose message it answers, when a person wrote it. */
const answeredBy = Effect.fn("Notifications.answeredBy")(function* (db: Executor, turnId: string) {
	const [answering] = yield* db
		.select({ userId: message.authorUserId, botId: bot.id, botName: bot.name })
		.from(turn)
		.innerJoin(bot, eq(bot.id, turn.botId))
		.innerJoin(message, eq(message.id, turn.triggerMessageId))
		.where(eq(turn.id, turnId));
	return answering;
});

/** The notifications a turn waiting for approvals sends: to each person who may decide one. */
export const forApprovals = Effect.fn("Notifications.forApprovals")(function* (
	db: Executor,
	waiting: { conversationId: string; turnId: string },
	now: Date,
) {
	const place = yield* placeOf(db, waiting.conversationId);
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
	const inAutomation = (yield* findRunId(db, waiting.conversationId)) !== undefined;
	const audience = yield* audienceOf(db, place, first.botId, now);
	const addressed: Addressed[] = [];
	for (const person of audience) {
		if (!wants(person, "approval", now)) continue;
		const decides = yield* mayDecideAny(db, waiting.conversationId, person.id, calls, inAutomation);
		if (!decides) continue;
		addressed.push({
			userId: person.id,
			notification: {
				title: `${first.botName} needs your approval`,
				body:
					calls.length === 1
						? `To run ${first.tool} in ${place.title}`
						: `To run ${calls.length} tools in ${place.title}`,
				tag: `approval:${waiting.turnId}`,
				path: `/${place.workspaceSlug}/approvals/${first.id}`,
				conversationId: place.rootConversationId,
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
	failed: { conversationId: string; turnId: string; messageId: string; userMessage: UserText },
	now: Date,
) {
	const place = yield* placeOf(db, failed.conversationId);
	if (!place || !NOTIFYING_CONVERSATION_KINDS.has(place.kind)) return [];
	const answering = yield* answeredBy(db, failed.turnId);
	if (!answering?.userId) return [];
	const audience = yield* audienceOf(db, place, place.botId ?? answering.botId, now);
	return audience
		.filter(
			(person) =>
				person.id === answering.userId &&
				(person.turnFailures ?? DEFAULT_TURN_FAILURES) &&
				wants(person, "failure", now),
		)
		.map(
			(person): Addressed => ({
				userId: person.id,
				notification: {
					title: `${answering.botName} couldn't finish its reply`,
					body: failed.userMessage,
					tag: conversationNotificationTag(place.rootConversationId),
					path: conversationPath(place, place.rootConversationId, { message: failed.messageId }),
					conversationId: place.rootConversationId,
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
	settled: { conversationId: string; rootConversationId: string },
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
		.where(eq(automationRun.conversationId, settled.conversationId));
	if (!run || (run.state !== "completed" && run.state !== "failed")) return [];
	const failed = run.state === "failed";
	const place = yield* placeOf(db, settled.conversationId);
	if (!place) return [];
	const owners = new Set([
		run.createdById,
		run.trigger.kind === "manual" ? run.trigger.requestedByUserId : null,
	]);
	const audience = yield* audienceOf(db, place, run.botId, now);
	return audience
		.filter((person) => {
			if (!owners.has(person.id)) return false;
			const chosen = person.automationRuns ?? DEFAULT_AUTOMATION_RUNS;
			const hears = chosen === "all" || (chosen === "failures" && failed);
			return hears && wants(person, "automation", now);
		})
		.map(
			(person): Addressed => ({
				userId: person.id,
				notification: {
					title: failed ? `${run.automationName} failed` : `${run.automationName} finished`,
					body: failed
						? (run.error ?? `${run.botName}'s run didn't finish.`)
						: `${run.botName} finished the run.`,
					tag: `automation:${settled.conversationId}`,
					path: conversationPath(place, settled.rootConversationId, {
						itemPage: settled.conversationId,
					}),
					conversationId: settled.rootConversationId,
				},
			}),
		);
});

/**
 * Where a message was written, after its author's name in a notification's
 * title: nothing in a direct message with one person, which is named for who
 * wrote it; else the place.
 */
function whereFrom(place: Place): string {
	if (place.kind === "direct_message") {
		const group = place.directKey && membersOfDirectKey(place.directKey).length > 2;
		return group ? " in a group message" : "";
	}
	return ` in ${place.title}`;
}

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

/** The conversation, the one it is in, and the addresses of its workspace and project, if it has one. */
const placeOf = Effect.fn("Notifications.placeOf")(function* (
	db: Executor,
	conversationId: string,
) {
	const conversation = alias(placedConversation, "conversation");
	const [row] = yield* db
		.select({
			kind: placedConversation.kind,
			/** A collaboration's is the project of the conversation it was opened from. */
			projectId: sql<
				string | null
			>`coalesce(${conversation.projectId}, ${placedConversation.projectId})`,
			botId: placedConversation.botId,
			workspaceId: placedConversation.workspaceId,
			rootConversationId: sql<string>`coalesce(${placedConversation.rootConversationId}, ${placedConversation.id})`,
			title: sql<string>`coalesce(${conversation.title}, ${placedConversation.title})`,
			/** Null outside a project people made: a bot's thread is reached through the bot. */
			projectSlug: project.slug,
			workspaceSlug: workspace.slug,
			/** On a direct message between people: the key naming everybody in it. */
			directKey: placedConversation.directKey,
		})
		.from(placedConversation)
		.leftJoin(conversation, eq(conversation.id, placedConversation.rootConversationId))
		.leftJoin(
			project,
			and(
				eq(project.id, sql`coalesce(${conversation.projectId}, ${placedConversation.projectId})`),
				isNull(project.defaultOfBotId),
			),
		)
		.innerJoin(workspace, eq(workspace.id, placedConversation.workspaceId))
		.where(eq(placedConversation.id, conversationId))
		.limit(1);
	return row;
});

type Person = Effect.Success<ReturnType<typeof audienceOf>>[number];

/**
 * Everybody who reaches the place, with the level they chose for `botId`, the
 * bot it is about, else for the project, else their own: the people who
 * reach the conversation.
 */
const audienceOf = Effect.fn("Notifications.audienceOf")(function* (
	db: Executor,
	place: Place,
	botId: string | null,
	now: Date,
) {
	const botLevel = alias(notificationOverride, "bot_level");
	const projectLevel = alias(notificationOverride, "project_level");
	return yield* db
		.select({
			id: user.id,
			name: user.name,
			participant: exists(
				sql`select 1 from ${conversationParticipant} where ${conversationParticipant.conversationId} = ${place.rootConversationId} and ${conversationParticipant.userId} = ${user.id}`,
			),
			// A project muted for a while quiets every bot in it, whatever level the bot has.
			level: sql<NotificationLevel | null>`coalesce(${mutedOf(projectLevel, now)}, ${mutedOf(botLevel, now)}, ${botLevel.level}, ${projectLevel.level}, ${notificationSettings.level})`,
			pausedUntil: notificationSettings.pausedUntil,
			quietHours: notificationSettings.quietHours,
			turnFailures: notificationSettings.turnFailures,
			automationRuns: notificationSettings.automationRuns,
		})
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.leftJoin(notificationSettings, eq(notificationSettings.userId, user.id))
		.leftJoin(
			botLevel,
			and(eq(botLevel.userId, user.id), botId === null ? sql`false` : eq(botLevel.botId, botId)),
		)
		.leftJoin(
			projectLevel,
			and(
				eq(projectLevel.userId, user.id),
				place.projectId === null ? sql`false` : eq(projectLevel.projectId, place.projectId),
			),
		)
		.where(
			and(
				eq(workspaceMember.workspaceId, place.workspaceId),
				reachesConversationFor(
					{
						id: sql`${place.rootConversationId}::uuid`,
						workspaceId: sql`${place.workspaceId}::uuid`,
						kind: sql`${place.kind}`,
						rootConversationId: sql`${place.rootConversationId}::uuid`,
						projectId: sql`${place.projectId}::uuid`,
					},
					user.id,
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
 * Whether `userId` may decide any of `calls`: they reach the conversation, and
 * `mayDecideToolCall` lets them decide it.
 */
const mayDecideAny = Effect.fn("Notifications.mayDecideAny")(function* (
	db: Executor,
	conversationId: string,
	userId: string,
	calls: ReadonlyArray<{ tool: string; botId: string }>,
	inAutomation: boolean,
) {
	const reached = yield* conversationStandingFor(db, conversationId, userId);
	if (!reached) return false;
	for (const call of calls) {
		const computerProject = yield* computerProjectStandingFor(
			db,
			conversationId,
			call.botId,
			userId,
		);
		if (mayDecideToolCall(reached, computerProject, inAutomation, decidersOf(call.tool))) {
			return true;
		}
	}
	return false;
});

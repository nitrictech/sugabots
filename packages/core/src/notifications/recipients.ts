import {
	conversationNotificationTag,
	handleFromName,
	mentionedHandles,
	type NotificationContent,
	type NotificationLevel,
	type QuietHours,
	type RoutineRunNotifications,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { type AnyColumn, and, eq, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { mayDecideApprovals, podStandingFor, reachesPodFor } from "../authorization/access.ts";
import { findRoutineExecutionId } from "../conversations/routines/execution.ts";
import { decidersOf } from "../conversations/tools/approval-deciders.ts";
import { ASK_FORM_TOOL } from "../conversations/tools/ask-form/tool.ts";
import type { Executor } from "../database/database.ts";
import {
	agent,
	message,
	notificationOverride,
	notificationSettings,
	pod,
	routine,
	routineExecution,
	thread,
	threadParticipant,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";

/**
 * Who is notified of what, decided as Slack decides it: by why the person
 * would care (they were mentioned, a bot replied to them or failed to, they
 * take part in the conversation, it waits on their approval, a routine of
 * theirs ran, or it is just activity), by the level they chose for the bot it
 * is about, else its pod, else themselves, and never while they are paused or
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
	| "reply"
	| "failure"
	| "participant"
	| "approval"
	| "routine"
	| "activity";

/** The level a person has before choosing one: Slack's "mentions and direct messages". */
export const DEFAULT_LEVEL: NotificationLevel = "mentions";

/** Whether a person hears of a bot's reply to them failing, before they choose. */
export const DEFAULT_TURN_FAILURES = true;

/** Which of a person's routines' runs they hear the end of, before they choose. */
export const DEFAULT_ROUTINE_RUNS: RoutineRunNotifications = "failures";

/** Whether somebody at `level` hears of something they would care about for `reason`. */
export function levelAdmits(level: NotificationLevel, reason: Reason): boolean {
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

/** A finished message somebody wrote in a conversation or a pod's chat. */
export interface WrittenMessage {
	threadId: string;
	messageId: string;
	author:
		| { kind: "person"; userId: string }
		| { kind: "bot"; agentId: string }
		| { kind: "routine" };
	authorName: string;
	content: string;
	/** The names of the files it shares, which stand in for its text when it has none. */
	fileNames: readonly string[];
	/** The person whose message it answers, who hears of it as of a reply in Slack. */
	repliesTo: string | null;
}

/**
 * The notifications a finished message sends. Only conversations, pods'
 * chats and bots' channels notify: routine runs, collaborations and system agents' threads are
 * bots' work, which reaches people through what they post in those.
 */
export const forMessage = Effect.fn("Notifications.forMessage")(function* (
	db: Executor,
	written: WrittenMessage,
	now: Date,
) {
	const preview = previewOf(written.content) || sharedFilesPreview(written.fileNames);
	if (!preview) return [];
	const place = yield* placeOf(db, written.threadId);
	if (!place || !NOTIFYING_THREAD_TYPES.has(place.type)) return [];
	const mentioned = new Set(mentionedHandles(written.content));
	const { author, authorName } = written;
	// A thread with a bot is the bot's; elsewhere, such as a pod's chat, what a bot posts is.
	const botId = place.hostAgentId ?? (author.kind === "bot" ? author.agentId : null);
	const audience = yield* audienceOf(db, place, botId, now);
	return audience.flatMap((person): Addressed[] => {
		if (author.kind === "person" && person.id === author.userId) return [];
		const reason: Reason = mentioned.has(handleFromName(person.name))
			? "mention"
			: person.id === written.repliesTo
				? "reply"
				: person.participant && place.type === "conversation"
					? "participant"
					: "activity";
		if (!wants(person, reason, now)) return [];
		// A bot's channel is named for it, so what the bot says there needs no "in".
		const where =
			place.type === "bot_channel" && author.kind === "bot" && author.agentId === place.hostAgentId
				? ""
				: ` in ${place.title}`;
		return [
			{
				userId: person.id,
				notification: {
					title:
						reason === "mention" ? `${authorName} mentioned you${where}` : `${authorName}${where}`,
					body: preview,
					tag: conversationNotificationTag(place.conversationId),
					path: activityPath(place, place.conversationId, { message: written.messageId }),
					conversationId: place.conversationId,
				},
			},
		];
	});
});

/** The notifications a bot's finished reply sends, as a reply to the person whose message it answers. */
export const forReply = Effect.fn("Notifications.forReply")(function* (
	db: Executor,
	completed: { threadId: string; turnId: string; messageId: string; content: string },
	now: Date,
) {
	const answering = yield* answeredBy(db, completed.turnId);
	if (!answering) return [];
	return yield* forMessage(
		db,
		{
			threadId: completed.threadId,
			messageId: completed.messageId,
			author: { kind: "bot", agentId: answering.agentId },
			authorName: answering.agentName,
			content: completed.content,
			fileNames: [],
			repliesTo: answering.userId,
		},
		now,
	);
});

/** The bot taking the turn, and the person whose message it answers, when a person wrote it. */
const answeredBy = Effect.fn("Notifications.answeredBy")(function* (db: Executor, turnId: string) {
	const [answering] = yield* db
		.select({ userId: message.authorUserId, agentId: agent.id, agentName: agent.name })
		.from(turn)
		.innerJoin(agent, eq(agent.id, turn.agentId))
		.innerJoin(message, eq(message.id, turn.triggerMessageId))
		.where(eq(turn.id, turnId));
	return answering;
});

/**
 * The notifications a turn waiting for approvals sends: to each person who may
 * decide one. Forms are answered in the thread, not on the approvals page, so
 * a person who may decide only forms is told of a form and sent to its message.
 */
export const forApprovals = Effect.fn("Notifications.forApprovals")(function* (
	db: Executor,
	waiting: { threadId: string; turnId: string },
	now: Date,
) {
	const place = yield* placeOf(db, waiting.threadId);
	if (!place) return [];
	const calls = yield* db
		.select({
			id: toolCall.id,
			tool: toolCall.tool,
			messageId: toolCall.messageId,
			agentId: agent.id,
			agentName: agent.name,
		})
		.from(toolCall)
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(agent, eq(agent.id, turn.agentId))
		.where(and(eq(toolCall.turnId, waiting.turnId), eq(toolCall.approvalStatus, "pending")))
		.orderBy(toolCall.startedAt);
	const [first] = calls;
	if (!first) return [];
	const forms = calls.filter((call) => call.tool === ASK_FORM_TOOL);
	const approvals = calls.filter((call) => call.tool !== ASK_FORM_TOOL);
	const inRoutine = (yield* findRoutineExecutionId(db, waiting.threadId)) !== undefined;
	const audience = yield* audienceOf(db, place, first.agentId, now);
	const addressed: Addressed[] = [];
	for (const person of audience) {
		if (!wants(person, "approval", now)) continue;
		const standing = yield* podStandingFor(db, place.podId, person.id);
		if (standing === undefined) continue;
		const decides = (call: { tool: string }) =>
			mayDecideApprovals(standing, inRoutine, decidersOf(call.tool));
		const approval = approvals.find(decides);
		const form = forms.find(decides);
		if (approval) {
			addressed.push({
				userId: person.id,
				notification: {
					title: `${first.agentName} needs your approval`,
					body:
						approvals.length === 1
							? `To run ${approval.tool} in ${place.title}`
							: `To run ${approvals.length} tools in ${place.title}`,
					tag: `approval:${waiting.turnId}`,
					path: `/${place.workspaceSlug}/approvals/${approval.id}`,
					conversationId: place.conversationId,
				},
			});
		} else if (form) {
			addressed.push({
				userId: person.id,
				notification: {
					title: `${first.agentName} asked you to fill in a form`,
					body: `In ${place.title}`,
					tag: `approval:${waiting.turnId}`,
					path: activityPath(place, place.conversationId, { message: form.messageId }),
					conversationId: place.conversationId,
				},
			});
		}
	}
	return addressed;
});

/**
 * The notification a bot's reply failing sends, to the person whose message
 * it was answering, unless the turn will run again.
 */
export const forFailedReply = Effect.fn("Notifications.forFailedReply")(function* (
	db: Executor,
	failed: { threadId: string; turnId: string; messageId: string; userMessage: UserText },
	now: Date,
) {
	const place = yield* placeOf(db, failed.threadId);
	if (!place || !NOTIFYING_THREAD_TYPES.has(place.type)) return [];
	const answering = yield* answeredBy(db, failed.turnId);
	if (!answering?.userId) return [];
	const audience = yield* audienceOf(db, place, place.hostAgentId ?? answering.agentId, now);
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
					title: `${answering.agentName} couldn't finish its reply`,
					body: failed.userMessage,
					tag: conversationNotificationTag(place.conversationId),
					path: activityPath(place, place.conversationId, { message: failed.messageId }),
					conversationId: place.conversationId,
				},
			}),
		);
});

/**
 * The notifications a routine run ending sends: to the person who made the
 * routine and the person who started the run, as they chose to hear of its
 * runs. A cancelled run sends none, since somebody stopped it on purpose.
 */
export const forRoutineRun = Effect.fn("Notifications.forRoutineRun")(function* (
	db: Executor,
	settled: { threadId: string; conversationId: string },
	now: Date,
) {
	const [run] = yield* db
		.select({
			state: routineExecution.state,
			error: routineExecution.error,
			trigger: routineExecution.trigger,
			routineName: routineExecution.routineName,
			agentId: routineExecution.agentId,
			agentName: agent.name,
			createdById: routine.createdById,
		})
		.from(routineExecution)
		.innerJoin(routine, eq(routine.id, routineExecution.routineId))
		.innerJoin(agent, eq(agent.id, routineExecution.agentId))
		.where(eq(routineExecution.threadId, settled.threadId));
	if (!run || (run.state !== "completed" && run.state !== "failed")) return [];
	const failed = run.state === "failed";
	const place = yield* placeOf(db, settled.threadId);
	if (!place) return [];
	const owners = new Set([
		run.createdById,
		run.trigger.kind === "manual" ? run.trigger.requestedByUserId : null,
	]);
	const audience = yield* audienceOf(db, place, run.agentId, now);
	return audience
		.filter((person) => {
			if (!owners.has(person.id)) return false;
			const chosen = person.routineRuns ?? DEFAULT_ROUTINE_RUNS;
			const hears = chosen === "all" || (chosen === "failures" && failed);
			return hears && wants(person, "routine", now);
		})
		.map(
			(person): Addressed => ({
				userId: person.id,
				notification: {
					title: failed ? `${run.routineName} failed` : `${run.routineName} finished`,
					body: failed
						? (run.error ?? `${run.agentName}'s run didn't finish.`)
						: `${run.agentName} finished the run.`,
					tag: `routine:${settled.threadId}`,
					path: activityPath(place, settled.conversationId, { threadPage: settled.threadId }),
					conversationId: settled.conversationId,
				},
			}),
		);
});

const NOTIFYING_THREAD_TYPES = new Set(["conversation", "pod_chat", "bot_channel"]);

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

function sharedFilesPreview(fileNames: readonly string[]): string {
	if (fileNames.length === 0) return "";
	return fileNames.length === 1 ? `Shared ${fileNames[0]}` : `Shared ${fileNames.length} files`;
}

type Place = NonNullable<Effect.Success<ReturnType<typeof placeOf>>>;

/** Where Inbox opens `conversationId` in the place's pod, with `search`, such as the message to show. */
function activityPath(
	place: Place,
	conversationId: string,
	search: Record<string, string>,
): string {
	return `/${place.workspaceSlug}/activity/${place.podSlug}/${conversationId}?${new URLSearchParams(search)}`;
}

/** The thread, the conversation it belongs to, and the addresses of its workspace and pod. */
const placeOf = Effect.fn("Notifications.placeOf")(function* (db: Executor, threadId: string) {
	const conversation = alias(thread, "conversation");
	const [row] = yield* db
		.select({
			type: thread.type,
			podId: thread.podId,
			hostAgentId: thread.hostAgentId,
			workspaceId: thread.workspaceId,
			conversationId: sql<string>`coalesce(${thread.conversationId}, ${thread.id})`,
			title: sql<string>`coalesce(${conversation.title}, ${thread.title})`,
			podSlug: pod.slug,
			workspaceSlug: workspace.slug,
		})
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.innerJoin(workspace, eq(workspace.id, thread.workspaceId))
		.leftJoin(conversation, eq(conversation.id, thread.conversationId))
		.where(eq(thread.id, threadId))
		.limit(1);
	return row;
});

type Person = Effect.Success<ReturnType<typeof audienceOf>>[number];

/**
 * Everybody who reaches the place's pod, with the level they chose for
 * `botId`, the bot it is about, else for the pod, else their own.
 */
const audienceOf = Effect.fn("Notifications.audienceOf")(function* (
	db: Executor,
	place: Place,
	botId: string | null,
	now: Date,
) {
	const botLevel = alias(notificationOverride, "bot_level");
	const podLevel = alias(notificationOverride, "pod_level");
	return yield* db
		.select({
			id: user.id,
			name: user.name,
			participant: exists(
				sql`select 1 from ${threadParticipant} where ${threadParticipant.threadId} = ${place.conversationId} and ${threadParticipant.userId} = ${user.id}`,
			),
			// A pod muted for a while quiets every bot in it, whatever level the bot has.
			level: sql<NotificationLevel | null>`coalesce(${mutedOf(podLevel, now)}, ${mutedOf(botLevel, now)}, ${botLevel.level}, ${podLevel.level}, ${notificationSettings.level})`,
			pausedUntil: notificationSettings.pausedUntil,
			quietHours: notificationSettings.quietHours,
			turnFailures: notificationSettings.turnFailures,
			routineRuns: notificationSettings.routineRuns,
		})
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.leftJoin(notificationSettings, eq(notificationSettings.userId, user.id))
		.leftJoin(
			botLevel,
			and(eq(botLevel.userId, user.id), botId === null ? sql`false` : eq(botLevel.agentId, botId)),
		)
		.leftJoin(podLevel, and(eq(podLevel.userId, user.id), eq(podLevel.podId, place.podId)))
		.where(
			and(
				eq(workspaceMember.workspaceId, place.workspaceId),
				reachesPodFor(sql`${place.podId}::uuid`, user.id),
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

import {
	conversationNotificationTag,
	handleFromName,
	mentionedHandles,
	mentionsEveryone,
	NOTIFYING_THREAD_TYPES,
	type NotificationContent,
	type NotificationLevel,
	type QuietHours,
	type RoutineRunNotifications,
} from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { type AnyColumn, and, eq, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
	agentStandingFor,
	mayDecideToolCall,
	reachesThreadFor,
	threadStandingFor,
} from "../authorization/access.ts";
import { findRoutineExecutionId } from "../conversations/routines/execution.ts";
import { membersOfDirectKey } from "../conversations/threads/repository.ts";
import { decidersOf } from "../conversations/tools/approval-deciders.ts";
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
 * is about, else its channel, else themselves, and never while they are paused or
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

/** A finished message somebody wrote in a task, a channel or a direct message. */
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
	/** The titles of the artifacts a routine's result shows, which stand in for its text when it has none. */
	artifactTitles: readonly string[];
	/** The person whose message it answers, who hears of it as of a reply in Slack. */
	repliesTo: string | null;
	/** The routine run it is the result of, and that run's own thread, when it is one. */
	resultOf: { executionId: string; threadId: string } | null;
}

/**
 * The notifications a finished message sends. Only tasks, channels and
 * direct messages notify: automation runs, collaborations and system bots'
 * threads are bots' work, which reaches people through what they post in
 * those. A direct message notifies the person it is to as a mention would. An
 * automation's result in its automation's thread notifies those it mentions,
 * which is how its bot asks for somebody.
 */
export const forMessage = Effect.fn("Notifications.forMessage")(function* (
	db: Executor,
	written: WrittenMessage,
	now: Date,
) {
	const preview =
		previewOf(written.content) ||
		sharedPreview(written.fileNames, "files") ||
		sharedPreview(written.artifactTitles, "artifacts");
	if (!preview) return [];
	const place = yield* placeOf(db, written.threadId);
	if (!place) return [];
	const routineResult = place.type === "routine_feed" ? written.resultOf : null;
	if (!routineResult && !NOTIFYING_THREAD_TYPES.has(place.type)) return [];
	if (routineResult && (yield* postedElsewhere(db, routineResult.executionId, written.threadId))) {
		return [];
	}
	const mentioned = new Set(mentionedHandles(written.content));
	const { author, authorName } = written;
	// Only a person's `@here` or `@channel`: a bot's would let whatever it read or was asked to say page the whole channel.
	const addressesEveryone = author.kind === "person" && mentionsEveryone(written.content);
	// A task is its bot's; in a channel, what a bot posts is.
	const botId = place.hostAgentId ?? (author.kind === "bot" ? author.agentId : null);
	const audience = yield* audienceOf(db, place, botId, now);
	return audience.flatMap((person): Addressed[] => {
		if (author.kind === "person" && person.id === author.userId) return [];
		const reason: Reason =
			place.type === "direct"
				? "direct"
				: addressesEveryone || mentioned.has(handleFromName(person.name))
					? "mention"
					: person.id === written.repliesTo
						? "reply"
						: person.participant && place.type === "conversation"
							? "participant"
							: "activity";
		if (routineResult && reason !== "mention") return [];
		if (!wants(person, reason, now)) return [];
		const where = whereFrom(place);
		return [
			{
				userId: person.id,
				notification: {
					title:
						reason === "mention" ? `${authorName} mentioned you${where}` : `${authorName}${where}`,
					body: preview,
					tag: conversationNotificationTag(place.conversationId),
					path: activityPath(
						place,
						place.conversationId,
						routineResult ? { threadPage: routineResult.threadId } : { message: written.messageId },
					),
					conversationId: place.conversationId,
				},
			},
		];
	});
});

/** Whether the run `executionId` posted its result in a thread besides `threadId`. */
const postedElsewhere = Effect.fn("Notifications.postedElsewhere")(function* (
	db: Executor,
	executionId: string,
	threadId: string,
) {
	const [elsewhere] = yield* db
		.select({ id: message.id })
		.from(message)
		.where(and(eq(message.routineExecutionId, executionId), ne(message.threadId, threadId)))
		.limit(1);
	return elsewhere !== undefined;
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
			artifactTitles: [],
			repliesTo: answering.userId,
			resultOf: null,
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

/** The notifications a turn waiting for approvals sends: to each person who may decide one. */
export const forApprovals = Effect.fn("Notifications.forApprovals")(function* (
	db: Executor,
	waiting: { threadId: string; turnId: string },
	now: Date,
) {
	const place = yield* placeOf(db, waiting.threadId);
	if (!place) return [];
	const calls = yield* db
		.select({ id: toolCall.id, tool: toolCall.tool, agentId: agent.id, agentName: agent.name })
		.from(toolCall)
		.innerJoin(turn, eq(turn.id, toolCall.turnId))
		.innerJoin(agent, eq(agent.id, turn.agentId))
		.where(and(eq(toolCall.turnId, waiting.turnId), eq(toolCall.approvalStatus, "pending")))
		.orderBy(toolCall.startedAt);
	const [first] = calls;
	if (!first) return [];
	const inRoutine = (yield* findRoutineExecutionId(db, waiting.threadId)) !== undefined;
	const audience = yield* audienceOf(db, place, first.agentId, now);
	const addressed: Addressed[] = [];
	for (const person of audience) {
		if (!wants(person, "approval", now)) continue;
		const decides = yield* mayDecideAny(db, waiting.threadId, person.id, calls, inRoutine);
		if (!decides) continue;
		addressed.push({
			userId: person.id,
			notification: {
				title: `${first.agentName} needs your approval`,
				body:
					calls.length === 1
						? `To run ${first.tool} in ${place.title}`
						: `To run ${calls.length} tools in ${place.title}`,
				tag: `approval:${waiting.turnId}`,
				path: `/${place.workspaceSlug}/approvals/${first.id}`,
				conversationId: place.conversationId,
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

/**
 * Where a message was written, after its author's name in a notification's
 * title: nothing in a direct message with one person, which is named for who
 * wrote it; else the place.
 */
function whereFrom(place: Place): string {
	if (place.type === "direct") {
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

function sharedPreview(names: readonly string[], plural: "files" | "artifacts"): string {
	if (names.length === 0) return "";
	return names.length === 1 ? `Shared ${names[0]}` : `Shared ${names.length} ${plural}`;
}

type Place = NonNullable<Effect.Success<ReturnType<typeof placeOf>>>;

/** Where `conversationId` opens: in its channel, as a task, or in the direct messages, with `search`, such as the message to show. */
function activityPath(
	place: Place,
	conversationId: string,
	search: Record<string, string>,
): string {
	if (place.type === "direct") {
		return `/${place.workspaceSlug}/dm/${conversationId}?${new URLSearchParams(search)}`;
	}
	const query = new URLSearchParams(search);
	if (place.podSlug !== null) {
		return `/${place.workspaceSlug}/channels/${place.podSlug}/${conversationId}?${query}`;
	}
	return `/${place.workspaceSlug}/tasks/${conversationId}?${query}`;
}

/** The thread, the conversation it belongs to, and the addresses of its workspace and channel, if it has one. */
const placeOf = Effect.fn("Notifications.placeOf")(function* (db: Executor, threadId: string) {
	const conversation = alias(thread, "conversation");
	const [row] = yield* db
		.select({
			type: thread.type,
			/** A collaboration's is the channel of the conversation it was opened from. */
			podId: sql<string | null>`coalesce(${conversation.podId}, ${thread.podId})`,
			hostAgentId: thread.hostAgentId,
			workspaceId: thread.workspaceId,
			conversationId: sql<string>`coalesce(${thread.conversationId}, ${thread.id})`,
			title: sql<string>`coalesce(${conversation.title}, ${thread.title})`,
			/** Null outside a channel. */
			podSlug: pod.slug,
			workspaceSlug: workspace.slug,
			/** On a direct message between people: the key naming everybody in it. */
			directKey: thread.directKey,
		})
		.from(thread)
		.leftJoin(conversation, eq(conversation.id, thread.conversationId))
		.leftJoin(pod, eq(pod.id, sql`coalesce(${conversation.podId}, ${thread.podId})`))
		.innerJoin(workspace, eq(workspace.id, thread.workspaceId))
		.where(eq(thread.id, threadId))
		.limit(1);
	return row;
});

type Person = Effect.Success<ReturnType<typeof audienceOf>>[number];

/**
 * Everybody who reaches the place, with the level they chose for `botId`, the
 * bot it is about, else for the channel, else their own: the people who
 * reach the thread.
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
			// A channel muted for a while quiets every bot in it, whatever level the bot has.
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
		.leftJoin(
			podLevel,
			and(
				eq(podLevel.userId, user.id),
				place.podId === null ? sql`false` : eq(podLevel.podId, place.podId),
			),
		)
		.where(
			and(
				eq(workspaceMember.workspaceId, place.workspaceId),
				reachesThreadFor(
					{
						id: sql`${place.conversationId}::uuid`,
						workspaceId: sql`${place.workspaceId}::uuid`,
						type: sql`${place.type}`,
						conversationId: sql`${place.conversationId}::uuid`,
						podId: sql`${place.podId}::uuid`,
						hostAgentId: sql`${place.hostAgentId}::uuid`,
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
 * Whether `userId` may decide any of `calls`: they reach the thread, and
 * `mayDecideToolCall` lets them decide it.
 */
const mayDecideAny = Effect.fn("Notifications.mayDecideAny")(function* (
	db: Executor,
	threadId: string,
	userId: string,
	calls: ReadonlyArray<{ tool: string; agentId: string }>,
	inRoutine: boolean,
) {
	const reached = yield* threadStandingFor(db, threadId, userId);
	if (!reached) return false;
	for (const call of calls) {
		const asking = yield* agentStandingFor(db, call.agentId, userId);
		if (mayDecideToolCall(reached, asking, inRoutine, decidersOf(call.tool))) return true;
	}
	return false;
});

import {
	handleFromName,
	mentionedHandles,
	NOTIFICATION_PREVIEW_CHARACTERS,
	type NotificationSubject,
	textWithoutNarration,
} from "@sugabots/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { podMembersWhoMay } from "../authorization/access.ts";
import type { ConversationEvent } from "../conversations/events.ts";
import { findRoutineExecutionId } from "../conversations/routines/execution.ts";
import { type Database, query } from "../database/database.ts";
import {
	agent,
	collaboration,
	message,
	pod,
	routine,
	routineExecution,
	thread,
	toolCall,
	turn,
	user,
} from "../database/schema.ts";

/**
 * Working out, from what happened in a conversation, what is worth telling
 * whom. Each kind is one mapping from the event it follows to a `Notice`.
 * Events do not carry who should be told, so each mapping queries that back.
 */

/** Something to tell `recipients` about, in a pod of the workspace `workspaceId`. */
export interface Notice {
	workspaceId: string;
	podId: string;
	/** Workspace members, in any order, repeats allowed. */
	recipients: readonly string[];
	/** Who did what the notice is about, who is never told of it. */
	actorUserId?: string;
	subject: NotificationSubject;
}

/** What `event` is worth telling people, if anything. */
export function noticeFor(
	event: ConversationEvent,
): Effect.Effect<Notice | undefined, never, Database> {
	switch (event._tag) {
		case "TurnSuspended":
			return approvalNotice(event);
		case "TurnCompleted":
			return directMessageNotice(event);
		case "MessagePosted":
			return mentionNotice(event);
		case "RoutineExecutionSettled":
			return routineNotice(event);
		case "CollaborationAnswered":
			return collaborationNotice(event, "answered");
		case "CollaborationFailed":
			return collaborationNotice(event, "failed");
		default:
			return Effect.undefined;
	}
}

/**
 * A bot's turn stopped for approvals: tell the people who may decide them.
 * An approval raised while a routine runs asks more of them than an ordinary
 * one, as `ToolApprovals.decide` does.
 */
const approvalNotice = Effect.fn("Notices.approvalNotice")(function* ({
	threadId,
	turnId,
}: Extract<ConversationEvent, { _tag: "TurnSuspended" }>) {
	const pending = yield* query((db) =>
		db
			.select({ tool: toolCall.tool })
			.from(toolCall)
			.where(and(eq(toolCall.turnId, turnId), eq(toolCall.approvalStatus, "pending")))
			.orderBy(asc(toolCall.atOffset), asc(toolCall.id)),
	);
	if (pending.length === 0) return undefined;
	const asking = yield* turnPlace(turnId);
	if (!asking) return undefined;
	const inRoutine = (yield* query((db) => findRoutineExecutionId(db, threadId))) !== undefined;
	const recipients = yield* query((db) =>
		podMembersWhoMay(
			db,
			asking.place.podId,
			inRoutine ? ["approval.decide", "approval.routine.decide"] : ["approval.decide"],
		),
	);
	return {
		workspaceId: asking.workspaceId,
		podId: asking.place.podId,
		recipients,
		subject: { kind: "approve", ...asking.place, tools: pending.map(({ tool }) => tool) },
	} satisfies Notice;
});

/**
 * A bot finished a reply in a chat: tell the pod's owner if it is Personal,
 * the person whose message it answered, and the people it mentions. A reply
 * in a routine run's or a collaboration's thread is left to their own kinds.
 */
const directMessageNotice = Effect.fn("Notices.directMessageNotice")(function* ({
	turnId,
	messageId,
	content,
	answeredCollaboration,
}: Extract<ConversationEvent, { _tag: "TurnCompleted" }>) {
	if (answeredCollaboration) return undefined;
	const replying = yield* turnPlace(turnId);
	if (replying?.place.threadType !== "chat") return undefined;
	const [asked] = yield* query((db) =>
		db
			.select({ authorUserId: message.authorUserId })
			.from(turn)
			.innerJoin(message, eq(message.id, turn.triggerMessageId))
			.where(eq(turn.id, turnId))
			.limit(1),
	);
	const [written] = yield* query((db) =>
		db.select({ parts: message.parts }).from(message).where(eq(message.id, messageId)).limit(1),
	);
	// The reply as its chat shows it, without the words it wrote before calling a tool.
	const shown = (written && textWithoutNarration(written.parts)) || content;
	const mentioned = new Set(mentionedHandles(shown));
	const readers = yield* podReaders(replying.place.podId);
	const recipients = readers
		.filter(
			(reader) =>
				replying.personalPod ||
				reader.userId === asked?.authorUserId ||
				mentioned.has(handleFromName(reader.name)),
		)
		.map(({ userId }) => userId);
	return {
		workspaceId: replying.workspaceId,
		podId: replying.place.podId,
		recipients,
		subject: { kind: "dm", ...replying.place, messageId, preview: previewOf(shown) },
	} satisfies Notice;
});

/** A person posted a message: tell the pod's people it mentions, apart from the poster. */
const mentionNotice = Effect.fn("Notices.mentionNotice")(function* ({
	threadId,
	message: posted,
}: Extract<ConversationEvent, { _tag: "MessagePosted" }>) {
	if (posted.author.kind !== "person") return undefined;
	const mentioned = new Set(mentionedHandles(posted.content));
	if (mentioned.size === 0) return undefined;
	const [placed] = yield* query((db) =>
		db
			.select({ thread, agentName: agent.name })
			.from(thread)
			.innerJoin(agent, eq(agent.id, thread.hostAgentId))
			.where(eq(thread.id, threadId))
			.limit(1),
	);
	if (!placed || placed.thread.type === "system_agent") return undefined;
	const readers = yield* podReaders(placed.thread.podId);
	return {
		workspaceId: placed.thread.workspaceId,
		podId: placed.thread.podId,
		recipients: readers
			.filter((reader) => mentioned.has(handleFromName(reader.name)))
			.map(({ userId }) => userId),
		actorUserId: posted.author.id,
		subject: {
			kind: "mention",
			...placeOf(placed.thread, placed.thread.hostAgentId, placed.agentName),
			messageId: posted.id,
			authorName: posted.author.name,
			preview: previewOf(posted.content),
		},
	} satisfies Notice;
});

/** A routine run ended: tell the person who made the routine, if they still reach its pod. */
const routineNotice = Effect.fn("Notices.routineNotice")(function* ({
	threadId,
}: Extract<ConversationEvent, { _tag: "RoutineExecutionSettled" }>) {
	const [run] = yield* query((db) =>
		db
			.select({
				thread,
				state: routineExecution.state,
				routineName: routineExecution.routineName,
				agentId: agent.id,
				agentName: agent.name,
				createdById: routine.createdById,
			})
			.from(routineExecution)
			.innerJoin(routine, eq(routine.id, routineExecution.routineId))
			.innerJoin(agent, eq(agent.id, routineExecution.agentId))
			.innerJoin(thread, eq(thread.id, routineExecution.threadId))
			.where(eq(routineExecution.threadId, threadId))
			.limit(1),
	);
	if (!run?.createdById) return undefined;
	if (run.state === "queued" || run.state === "running") return undefined;
	const { createdById } = run;
	const readers = yield* podReaders(run.thread.podId);
	return {
		workspaceId: run.thread.workspaceId,
		podId: run.thread.podId,
		recipients: readers.filter(({ userId }) => userId === createdById).map(({ userId }) => userId),
		subject: {
			kind: "routine",
			...placeOf(run.thread, run.agentId, run.agentName),
			routineName: run.routineName,
			outcome: run.state,
		},
	} satisfies Notice;
});

/**
 * A bot's request for help ended: tell the person whose message the asking
 * bot was answering, if they still reach the pod.
 */
const collaborationNotice = Effect.fn("Notices.collaborationNotice")(function* (
	{
		parentMessageId,
		collaboration: asked,
	}: Extract<ConversationEvent, { _tag: "CollaborationAnswered" | "CollaborationFailed" }>,
	outcome: "answered" | "failed",
) {
	const [found] = yield* query((db) =>
		db
			.select({ turnId: collaboration.turnId, triggerMessageId: turn.triggerMessageId })
			.from(collaboration)
			.innerJoin(turn, eq(turn.id, collaboration.turnId))
			.where(
				and(eq(collaboration.id, asked.id), eq(collaboration.parentMessageId, parentMessageId)),
			)
			.limit(1),
	);
	if (!found) return undefined;
	const asking = yield* turnPlace(found.turnId);
	if (!asking) return undefined;
	const [trigger] = yield* query((db) =>
		db
			.select({ authorUserId: message.authorUserId })
			.from(message)
			.where(eq(message.id, found.triggerMessageId))
			.limit(1),
	);
	const askedBy = trigger?.authorUserId;
	if (!askedBy) return undefined;
	const readers = yield* podReaders(asking.place.podId);
	return {
		workspaceId: asking.workspaceId,
		podId: asking.place.podId,
		recipients: readers.filter(({ userId }) => userId === askedBy).map(({ userId }) => userId),
		subject: { kind: "collab", ...asking.place, collaboratorName: asked.agentName, outcome },
	} satisfies Notice;
});

/** Where a notification about `threadId`, and the bot `agentId` in it, opens. */
function placeOf(
	placed: Pick<typeof thread.$inferSelect, "id" | "podId" | "chatId" | "type">,
	agentId: string,
	agentName: string,
) {
	return {
		podId: placed.podId,
		chatId: placed.chatId,
		threadId: placed.id,
		threadType: placed.type,
		agentId,
		agentName,
	};
}

/** Where the turn `turnId` took place, and whether its pod is somebody's Personal one. */
const turnPlace = Effect.fn("Notices.turnPlace")(function* (turnId: string) {
	const [found] = yield* query((db) =>
		db
			.select({ thread, agentId: agent.id, agentName: agent.name, podKind: pod.kind })
			.from(turn)
			.innerJoin(agent, eq(agent.id, turn.agentId))
			.innerJoin(thread, eq(thread.id, turn.threadId))
			.innerJoin(pod, eq(pod.id, thread.podId))
			.where(eq(turn.id, turnId))
			.limit(1),
	);
	if (!found) return undefined;
	return {
		workspaceId: found.thread.workspaceId,
		personalPod: found.podKind === "personal",
		place: placeOf(found.thread, found.agentId, found.agentName),
	};
});

/** The people who reach the pod `podId`, with their names, from which their handles come. */
const podReaders = Effect.fn("Notices.podReaders")(function* (podId: string) {
	const userIds = yield* query((db) => podMembersWhoMay(db, podId, ["pod.read"]));
	if (userIds.length === 0) return [];
	return yield* query((db) =>
		db
			.select({ userId: user.id, name: user.name })
			.from(user)
			.where(inArray(user.id, [...userIds])),
	);
});

/** The start of `content` on one line, cut at a word to at most `NOTIFICATION_PREVIEW_CHARACTERS`. */
function previewOf(content: string): string {
	const line = content.replace(/\s+/g, " ").trim();
	if (line.length <= NOTIFICATION_PREVIEW_CHARACTERS) return line;
	const cut = line.slice(0, NOTIFICATION_PREVIEW_CHARACTERS - 1);
	const atWord = cut.lastIndexOf(" ");
	return `${(atWord > 0 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

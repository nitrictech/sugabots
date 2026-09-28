export * as ThreadView from "./thread-view.ts";

import type {
	Thread,
	ThreadActivity,
	ThreadDetails,
	ThreadHistoryQuery,
	ThreadParticipant,
	ThreadSummary,
	WorkspaceRole,
} from "@sugabots/contracts";
import { DEFAULT_THREAD_HISTORY_LIMIT } from "@sugabots/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { podMember, thread, threadSummary, workspaceMember } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { mayInPod } from "../../workspaces/permissions.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { routineExecutionIdOf, toRoutineExecution } from "../routines/execution.ts";
import { respondingIn } from "../turns/requests.ts";
import {
	agentColumns,
	authorRow,
	messageFromRelations,
	messageRelations,
	personColumns,
	recentParticipantsOf,
	toParticipant,
} from "./participants.ts";
import { visibleThread } from "./visibility.ts";

/** What the thread screens show: the thread list, a thread with its messages, and its sidebar. */
export interface Interface {
	/** The threads this person can see in a workspace, newest activity first. */
	readonly listVisible: (workspaceId: string, userId: string) => Effect.Effect<Thread[]>;
	/** The thread's id if this person may see it, else `undefined`. */
	readonly visibleThreadId: (threadId: string, userId: string) => Effect.Effect<string | undefined>;
	readonly getVisible: (
		threadId: string,
		userId: string,
		history?: ThreadHistoryQuery,
	) => Effect.Effect<ThreadDetails | undefined, InvalidThreadHistoryCursor>;
	/** What the thread's sidebar shows, if this person may see the thread. */
	readonly activity: (
		threadId: string,
		userId: string,
	) => Effect.Effect<ThreadActivity | undefined>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ThreadView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ThreadView");
	return Service.of({
		listVisible: (workspaceId, userId) =>
			operation(
				"listVisible",
				query((db) =>
					Effect.gen(function* () {
						const rows = yield* db
							.select({ thread, running: respondingIn(sql`${thread.id}`) })
							.from(thread)
							// Child threads, whether a system agent's or a collaboration's, are reached
							// from the thread they hang off rather than listed beside it.
							.where(
								and(
									eq(thread.workspaceId, workspaceId),
									isNull(thread.parentThreadId),
									reachesPod(thread.podId, userId),
								),
							)
							.orderBy(desc(thread.updatedAt), desc(thread.id));

						return rows.map(({ thread: row, running }) => toThread(row, running));
					}),
				),
			),

		visibleThreadId: (threadId, userId) =>
			operation(
				"visibleThreadId",
				query((db) => visibleThread(db, threadId, userId)).pipe(Effect.map((row) => row?.id)),
			),

		getVisible: (threadId, userId, history = { limit: DEFAULT_THREAD_HISTORY_LIMIT }) =>
			operation(
				"getVisible",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("thread.id", threadId);
					if (!isUuid(threadId)) return undefined;
					// Before the query, and whether or not the thread is there, so a bad cursor
					// says nothing about the thread.
					const before = history.cursor ? yield* historyCursor(history.cursor) : undefined;
					const row = yield* query((db) =>
						loadConversation(db, threadId, userId, history.limit, before),
					);
					return row ? toThreadDetails(row, userId, history.limit) : undefined;
				}),
			),

		activity: (threadId, userId) =>
			operation(
				"activity",
				Effect.gen(function* () {
					if (!isUuid(threadId)) return undefined;
					const [row] = yield* query((db) =>
						db
							.select({
								summary: threadSummary,
								recentParticipants: recentParticipantsOf(thread.id),
							})
							.from(thread)
							.leftJoin(threadSummary, eq(threadSummary.threadId, thread.id))
							.where(and(eq(thread.id, threadId), reachesPod(thread.podId, userId))),
					);
					if (!row) return undefined;
					return {
						summary: row.summary ? toThreadSummary(row.summary) : null,
						recentParticipants: row.recentParticipants.map(toParticipant),
					};
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

export class InvalidThreadHistoryCursor
	extends Data.TaggedError("InvalidThreadHistoryCursor")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That thread history cursor is invalid`;
	}
}

/**
 * The thread, a page of its messages with their authors and the parts placed in
 * them, its participants, its pod's crew, and the facts deciding what the
 * caller may approve: one statement. Nothing when the caller does not reach
 * the thread's pod.
 */
const loadConversation = Effect.fn("ThreadView.loadConversation")(function* (
	db: Executor,
	threadId: string,
	userId: string,
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.thread.findFirst({
		where: { id: threadId, RAW: (row) => reachesPod(row.podId, userId) },
		extras: {
			running: (row) => respondingIn(sql`${row.id}`),
			routineExecutionId: (row) => routineExecutionIdOf(row.id),
			workspaceRole: (row) => sql<WorkspaceRole | null>`(
				select ${workspaceMember.role} from ${workspaceMember}
				where ${workspaceMember.workspaceId} = ${row.workspaceId} and ${workspaceMember.userId} = ${userId}
			)`,
			isPodMember: (row) => sql<boolean>`exists (
				select 1 from ${podMember}
				where ${podMember.podId} = ${row.podId} and ${podMember.userId} = ${userId}
			)`,
		},
		with: {
			pod: {
				columns: { kind: true, ownerId: true },
				with: {
					agents: {
						...agentColumns,
						where: { systemAgentKey: { isNull: true } },
						orderBy: { name: "asc" },
					},
				},
			},
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { user: personColumns, agent: agentColumns },
			},
			routineExecution: true,
			messages: {
				// One more than the page, so an older page is known to exist without a count.
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				...(before && {
					where: {
						RAW: (row) => earlierThan(row.createdAt, row.id, before),
					},
				}),
				with: {
					...messageRelations,
					// A failed reply's reason lives on its turn.
					turn: { columns: { error: true } },
				},
			},
		},
	});
});

type Conversation = NonNullable<Effect.Success<ReturnType<typeof loadConversation>>>;

function toThreadDetails(row: Conversation, userId: string, limit: number): ThreadDetails {
	const actor = { userId, workspaceRole: row.workspaceRole ?? undefined };
	const pod = { kind: row.pod.kind, ownerId: row.pod.ownerId, isExplicitMember: row.isPodMember };
	const page = row.messages.slice(0, limit).reverse();
	const oldest = page[0];
	return {
		thread: toThread(row, row.running),
		// What this person may do with the approvals this thread raises, decided
		// once here so the conversation does not have to work it out from a role.
		capabilities: {
			approveToolCalls: mayInPod(
				actor,
				row.routineExecutionId ? "approval.routine.decide" : "approval.decide",
				pod,
			),
		},
		routineExecution: row.routineExecution ? toRoutineExecution(row.routineExecution) : null,
		participants: row.participants.map(({ user: person, agent: participant }) =>
			toParticipant(authorRow(person, participant)),
		),
		crew: row.pod.agents.map((crewAgent): ThreadParticipant => ({ kind: "agent", ...crewAgent })),
		messages: page.map((stored) => messageFromRelations(stored, stored.turn?.error)),
		olderMessagesCursor:
			row.messages.length > limit && oldest
				? encodeCursor({ at: oldest.createdAt, id: oldest.id })
				: null,
	};
}

function toThreadSummary(row: schema.ThreadSummaryRow): ThreadSummary {
	return {
		content: row.content,
		sourceMessageId: row.sourceMessageId,
		updatedAt: row.updatedAt.toISOString(),
	};
}

const historyCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidThreadHistoryCursor());
};

function toThread(row: schema.ThreadRow, running: boolean): Thread {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		hostAgentId: row.hostAgentId,
		chatId: row.chatId,
		type: row.type,
		title: row.title,
		status: running ? "running" : "done",
		parentThreadId: row.parentThreadId,
		initiatorUserId: row.initiatorUserId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export * as ThreadView from "./thread-view.ts";

import type {
	Thread,
	ThreadActivity,
	ThreadDetails,
	ThreadHistoryQuery,
	ThreadParticipant,
	ThreadSummary,
} from "@sugabots/contracts";
import { DEFAULT_THREAD_HISTORY_LIMIT } from "@sugabots/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { type Executor, query, serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { thread, threadSummary } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import {
	type AuthorizationDenied,
	ResourceHidden,
	type ThreadStanding,
} from "../../workspaces/access.ts";
import { Authorization } from "../../workspaces/authorization.ts";
import type { CurrentActor } from "../../workspaces/current-actor.ts";
import { Visibility } from "../../workspaces/visibility.ts";
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

/**
 * What the thread screens show, of the threads the current actor can see: the
 * thread list, a thread with its messages, and its sidebar.
 */
export interface Interface {
	/** The threads in a workspace, by its id or its slug, newest activity first. */
	readonly list: (
		workspace: string,
	) => Effect.Effect<Thread[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		threadId: string,
		history?: ThreadHistoryQuery,
	) => Effect.Effect<
		ThreadDetails,
		ResourceHidden | InvalidThreadHistoryCursor,
		CurrentActor.Service
	>;
	/** What the thread's sidebar shows. */
	readonly activity: (
		threadId: string,
	) => Effect.Effect<ThreadActivity, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ThreadView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ThreadView");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	return Service.of({
		list: (workspace) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const reachesPod = yield* visibility.reachesPod;
					return yield* query((db) =>
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
										reachesPod(thread.podId),
									),
								)
								.orderBy(desc(thread.updatedAt), desc(thread.id));

							return rows.map(({ thread: row, running }) => toThread(row, running));
						}),
					);
				}),
			),

		get: (threadId, history = { limit: DEFAULT_THREAD_HISTORY_LIMIT }) =>
			operation(
				"get",
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("thread.id", threadId);
					// Before anything is looked up, and whether or not the thread is there,
					// so a bad cursor says nothing about the thread.
					const before = history.cursor ? yield* historyCursor(history.cursor) : undefined;
					const standing = yield* visibility.thread(threadId);
					const row = yield* query((db) => loadConversation(db, threadId, history.limit, before));
					if (!row) return yield* new ResourceHidden({ resource: "thread" });
					return toThreadDetails(row, standing, history.limit);
				}),
			),

		activity: (threadId) =>
			operation(
				"activity",
				Effect.gen(function* () {
					if (!isUuid(threadId)) return yield* new ResourceHidden({ resource: "thread" });
					const reachesPod = yield* visibility.reachesPod;
					const [row] = yield* query((db) =>
						db
							.select({
								summary: threadSummary,
								recentParticipants: recentParticipantsOf(thread.id),
							})
							.from(thread)
							.leftJoin(threadSummary, eq(threadSummary.threadId, thread.id))
							.where(and(eq(thread.id, threadId), reachesPod(thread.podId))),
					);
					if (!row) return yield* new ResourceHidden({ resource: "thread" });
					return {
						summary: row.summary ? toThreadSummary(row.summary) : null,
						recentParticipants: row.recentParticipants.map(toParticipant),
					};
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

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
 * them, its participants and its pod's crew: one statement.
 */
const loadConversation = Effect.fn("ThreadView.loadConversation")(function* (
	db: Executor,
	threadId: string,
	limit: number,
	before: CursorPoint | undefined,
) {
	return yield* db.query.thread.findFirst({
		where: { id: threadId },
		extras: {
			running: (row) => respondingIn(sql`${row.id}`),
			routineExecutionId: (row) => routineExecutionIdOf(row.id),
		},
		with: {
			pod: {
				columns: {},
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

function toThreadDetails(
	row: Conversation,
	standing: ThreadStanding,
	limit: number,
): ThreadDetails {
	const page = row.messages.slice(0, limit).reverse();
	const oldest = page[0];
	return {
		thread: toThread(row, row.running),
		// What this person may do with the approvals this thread raises, decided
		// once here so the conversation does not have to work it out from a role.
		capabilities: {
			approveToolCalls: standing.may(
				row.routineExecutionId ? "approval.routine.decide" : "approval.decide",
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

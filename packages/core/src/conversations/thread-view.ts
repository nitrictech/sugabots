export * as ThreadView from "./thread-view.ts";

import type {
	Thread,
	ThreadActivity,
	ThreadContext,
	ThreadDetails,
	ThreadHistoryQuery,
	ThreadParticipant,
	ThreadSummary,
} from "@sugabots/contracts";
import { DEFAULT_THREAD_HISTORY_LIMIT } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, desc, eq, isNull, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import {
	type AuthorizationDenied,
	mayDecideApprovals,
	ResourceHidden,
	type ThreadStanding,
} from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { type Executor, query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import {
	routine,
	thread,
	threadCompaction,
	threadSummary,
	turn,
	workspaceMember,
} from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import { compactionLineTokens } from "./compaction/window.ts";
import { type CursorPoint, decodeCursor, earlierThan, encodeCursor } from "./cursor.ts";
import { latestRunFailed, routineExecutionIdOf, toRoutineExecution } from "./routines/routines.ts";
import {
	agentColumns,
	authorRow,
	messageFromRelations,
	messageRelations,
	personColumns,
	recentParticipantsOf,
	toParticipant,
	toPerson,
} from "./threads/participants.ts";
import { Turns } from "./turns/turns.ts";

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
					const reachesThread = yield* visibility.reachesThread;
					return yield* query((db) =>
						Effect.gen(function* () {
							const rows = yield* db
								.select({ thread, running: Turns.busyIn(sql`${thread.id}`) })
								.from(thread)
								// Child threads, whether a system agent's or a collaboration's, are reached
								// from the thread they hang off rather than listed beside it.
								.where(
									and(
										eq(thread.workspaceId, workspaceId),
										isNull(thread.parentThreadId),
										reachesThread(thread),
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
					const row = yield* query((db) =>
						loadConversation(db, standing.thread, history.limit, before),
					);
					if (!row) return yield* new ResourceHidden({ resource: "thread" });
					const details = toThreadDetails(row, standing, history.limit);
					const { routineId } = row;
					if (!routineId) return details;
					const [owned] = yield* query((db) =>
						db
							.select({
								id: routine.id,
								agentId: routine.agentId,
								state: routine.state,
								failed: latestRunFailed(routine.id),
								pausedAfterFailuresAt: routine.pausedAfterFailuresAt,
							})
							.from(routine)
							.where(eq(routine.id, routineId))
							.limit(1),
					);
					if (!owned) return details;
					const { pausedAfterFailuresAt, ...stands } = owned;
					return {
						...details,
						routine: { ...stands, pausedAfterFailures: pausedAfterFailuresAt !== null },
					};
				}),
			),

		activity: (threadId) =>
			operation(
				"activity",
				Effect.gen(function* () {
					if (!isUuid(threadId)) return yield* new ResourceHidden({ resource: "thread" });
					const reachesThread = yield* visibility.reachesThread;
					const [row] = yield* query((db) =>
						db
							.select({
								summary: threadSummary,
								recentParticipants: recentParticipantsOf(thread.id),
								measured: latestMeasurementOf(thread.id),
								compactedAt: threadCompaction.updatedAt,
							})
							.from(thread)
							.leftJoin(threadSummary, eq(threadSummary.threadId, thread.id))
							.leftJoin(threadCompaction, eq(threadCompaction.threadId, thread.id))
							.where(and(eq(thread.id, threadId), reachesThread(thread))),
					);
					if (!row) return yield* new ResourceHidden({ resource: "thread" });
					return {
						summary: row.summary ? toThreadSummary(row.summary) : null,
						context: row.measured === null ? null : toThreadContext(row.measured, row.compactedAt),
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
		return userText`That thread history cursor is invalid`;
	}
}

/**
 * The thread `place`, a page of its messages with their authors and the parts
 * placed in them, its participants and its pod's crew and members, or a direct
 * message's people: one statement. In a direct message, who has left the
 * workspace keeps their rows, to have the conversation back should they rejoin,
 * but is left out of who is in it, who joined in and who read it.
 */
const loadConversation = Effect.fn("ThreadView.loadConversation")(function* (
	db: Executor,
	place: Pick<schema.ThreadRow, "id" | "type" | "workspaceId">,
	limit: number,
	before: CursorPoint | undefined,
) {
	const direct = place.type === "direct";
	/** In a direct message, whether the person `userId` is still in the workspace, and so in it. */
	const stillHere = (userId: SQLWrapper) => inWorkspace(userId, place.workspaceId);
	return yield* db.query.thread.findFirst({
		where: { id: place.id },
		extras: {
			running: (row) => Turns.busyIn(sql`${row.id}`),
			queuedSince: (row) => Turns.queuedSince(sql`${row.id}`),
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
					members: { ...personColumns, orderBy: { name: "asc" } },
				},
			},
			// Only a direct message has any, so no other thread looks.
			...(direct && {
				directMembers: {
					...personColumns,
					where: { RAW: (person: { id: SQLWrapper }) => stillHere(person.id) },
					orderBy: { name: "asc" as const },
				},
			}),
			participants: {
				columns: {},
				// A bot joins in with no person.
				...(direct && {
					where: { RAW: (row) => sql`(${row.userId} is null or ${stillHere(row.userId)})` },
				}),
				orderBy: { createdAt: "asc", id: "asc" },
				with: { user: personColumns, agent: agentColumns },
			},
			reads: {
				columns: { readThrough: true, updatedAt: true },
				...(direct && { where: { RAW: (row) => stillHere(row.userId) } }),
				with: { user: personColumns },
			},
			routineExecution: true,
			origin: { with: messageRelations },
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
			// Only a thread in a pod raises approvals: a direct message has no bots.
			approveToolCalls:
				standing.kind === "pod" &&
				mayDecideApprovals(standing.standing, row.routineExecutionId !== null, "pod"),
			approveSandboxRequests:
				standing.kind === "pod" &&
				mayDecideApprovals(standing.standing, row.routineExecutionId !== null, "sandbox-managers"),
		},
		// A run's thread is always opened in a conversation.
		routineExecution:
			row.routineExecution && row.conversationId
				? toRoutineExecution(row.routineExecution, row.conversationId)
				: null,
		startedFrom: row.origin && messageFromRelations(row.origin),
		participants: row.participants.map(({ user: person, agent: participant }) =>
			toParticipant(authorRow(person, participant)),
		),
		crew: (row.pod?.agents ?? []).map(
			(crewAgent): ThreadParticipant => ({ kind: "agent", ...crewAgent }),
		),
		// A direct message's people are its members, as a pod's are the pod's.
		members: (row.pod?.members ?? row.directMembers ?? []).map(toPerson),
		messages: page.map((stored) => messageFromRelations(stored, stored.turn?.error)),
		olderMessagesCursor:
			row.messages.length > limit && oldest
				? encodeCursor({ at: oldest.createdAt, id: oldest.id })
				: null,
		queuedSince: row.queuedSince,
		reads: row.reads.map((read) => ({
			person: toPerson(read.user),
			readThrough: read.readThrough.toISOString(),
			// Written whenever they read further, so when they last did.
			readAt: read.updatedAt.toISOString(),
		})),
	};
}

/** SQL for "`userId` is a member of the workspace `workspaceId`". */
const inWorkspace = (userId: SQLWrapper, workspaceId: string) => sql<boolean>`exists (
	select 1
	from ${workspaceMember}
	where ${workspaceMember.userId} = ${userId}
		and ${workspaceMember.workspaceId} = ${workspaceId}
)`;

/**
 * How many tokens the prompt of the thread's latest measured turn took, the
 * window it was read with, and when. Its own turns only: the Scribe's and the
 * Compaction agent's are in child threads.
 */
const latestMeasurementOf = (threadId: SQLWrapper) => sql<Measurement | null>`(
	select json_build_object('tokens', ${turn.contextTokens}, 'window', ${turn.contextCapacity}, 'at', coalesce(${turn.finishedAt}, ${turn.createdAt}))
	from ${turn}
	where ${turn.threadId} = ${threadId} and ${turn.contextTokens} is not null
	order by ${turn.createdAt} desc
	limit 1
)`;

/** A turn's prompt size, the window it was read with (unset on older turns), and when. */
interface Measurement {
	tokens: number;
	window: number | null;
	at: string;
}

/** The context the thread's latest measured turn used, against the window that turn read with. */
function toThreadContext(measured: Measurement, compactedAt: Date | null): ThreadContext {
	const windowTokens = Turns.contextWindowTokens(measured.window);
	return {
		usedTokens: measured.tokens,
		measuredAt: DateTime.formatIso(DateTime.makeUnsafe(measured.at)),
		windowTokens,
		compactionLineTokens: compactionLineTokens(windowTokens),
		compactedAt: compactedAt?.toISOString() ?? null,
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
		conversationId: row.conversationId,
		type: row.type,
		title: row.title,
		status: running ? "running" : "done",
		parentThreadId: row.parentThreadId,
		initiatorUserId: row.initiatorUserId,
		doneAt: row.doneAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

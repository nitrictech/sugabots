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
import { Data, Effect } from "effect";
import { type Database, type Executor, query } from "../../database/database.ts";
import { isUuid } from "../../database/ids.ts";
import type * as schema from "../../database/schema.ts";
import { podMember, thread, threadSummary, workspaceMember } from "../../database/schema.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { mayInPod } from "../../workspaces/permissions.ts";
import { hasPendingResponseJob } from "../jobs/queue.ts";
import { routineExecutionIdOf, toRoutineExecution } from "../routines/execution.ts";
import { toCollaborationPart } from "./collaborations.ts";
import {
	type ParticipantRow,
	recentParticipantsOf,
	toMessage,
	toParticipant,
} from "./participants.ts";
import { toToolCallPart } from "./tool-calls.ts";
import { visibleThread } from "./visibility.ts";

export interface ThreadStore {
	/** The threads this person can see in a workspace, newest activity first. */
	listVisible(workspaceId: string, userId: string): Effect.Effect<Thread[], never, Database>;
	/** The thread's id if this person may see it, else `undefined`. */
	visibleThreadId(
		threadId: string,
		userId: string,
	): Effect.Effect<string | undefined, never, Database>;
	getVisible(
		threadId: string,
		userId: string,
		history?: ThreadHistoryQuery,
	): Effect.Effect<ThreadDetails | undefined, InvalidThreadHistoryCursor, Database>;
	/** What the thread's sidebar shows, if this person may see the thread. */
	activity(
		threadId: string,
		userId: string,
	): Effect.Effect<ThreadActivity | undefined, never, Database>;
}

export class InvalidThreadHistoryCursor extends Data.TaggedError("InvalidThreadHistoryCursor") {
	override get message() {
		return "That thread history cursor is invalid";
	}
}

export function threadStore(): ThreadStore {
	return {
		listVisible: (workspaceId, userId) =>
			query((db) =>
				Effect.gen(function* () {
					const rows = yield* db
						.select({ thread, running: hasPendingResponseJob(sql`${thread.id}`) })
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

		visibleThreadId: (threadId, userId) =>
			query((db) => visibleThread(db, threadId, userId)).pipe(Effect.map((row) => row?.id)),

		getVisible: Effect.fn("ThreadStore.getVisible")(function* (
			threadId: string,
			userId: string,
			history: ThreadHistoryQuery = { limit: DEFAULT_THREAD_HISTORY_LIMIT },
		) {
			yield* Effect.annotateCurrentSpan("thread.id", threadId);
			if (!isUuid(threadId)) return undefined;
			// Before the query, and whether or not the thread is there, so a bad cursor
			// says nothing about the thread.
			const before = history.cursor ? yield* decodeHistoryCursor(history.cursor) : undefined;
			const row = yield* query((db) =>
				loadConversation(db, threadId, userId, history.limit, before),
			);
			return row ? toThreadDetails(row, userId, history.limit) : undefined;
		}),

		activity: Effect.fn("ThreadStore.activity")(function* (threadId: string, userId: string) {
			if (!isUuid(threadId)) return undefined;
			const [row] = yield* query((db) =>
				db
					.select({ summary: threadSummary, recentParticipants: recentParticipantsOf(thread.id) })
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
	};
}

/** Where a history page starts: the message the previous page ended on. */
interface HistoryPoint {
	createdAt: Date;
	id: string;
}

/**
 * The thread, a page of its messages with their authors and the parts placed in
 * them, its participants, its pod's crew, and the facts deciding what the
 * caller may approve: one statement. Nothing when the caller does not reach
 * the thread's pod.
 */
const loadConversation = Effect.fn("ThreadStore.loadConversation")(function* (
	db: Executor,
	threadId: string,
	userId: string,
	limit: number,
	before: HistoryPoint | undefined,
) {
	const person = { columns: { id: true, name: true, image: true } } as const;
	const agentIdentity = {
		columns: { id: true, name: true, handle: true, color: true, face: true },
	} as const;
	return yield* db.query.thread.findFirst({
		where: { id: threadId, RAW: (row) => reachesPod(row.podId, userId) },
		extras: {
			running: (row) => hasPendingResponseJob(sql`${row.id}`),
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
						...agentIdentity,
						where: { systemAgentKey: { isNull: true } },
						orderBy: { name: "asc" },
					},
				},
			},
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { user: person, agent: agentIdentity },
			},
			routineExecution: true,
			messages: {
				// One more than the page, so an older page is known to exist without a count.
				limit: limit + 1,
				orderBy: { createdAt: "desc", id: "desc" },
				...(before && {
					where: {
						RAW: (row) => sql`(${row.createdAt}, ${row.id}) < (${before.createdAt}, ${before.id})`,
					},
				}),
				with: {
					authorUser: person,
					authorAgent: agentIdentity,
					// A failed reply's reason lives on its turn.
					turn: { columns: { error: true } },
					toolCalls: {
						orderBy: { startedAt: "asc", id: "asc" },
						with: { decidedBy: { columns: { name: true } } },
					},
					collaborations: { with: { collaborator: { columns: { name: true } } } },
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
		messages: page.map((stored) =>
			toMessage(
				stored,
				authorRow(stored.authorUser, stored.authorAgent),
				{
					toolCalls: stored.toolCalls.map((call) => toToolCallPart(call, call.decidedBy?.name)),
					collaborations: stored.collaborations.map((made) =>
						toCollaborationPart(made, made.collaborator.name),
					),
				},
				stored.turn?.error,
			),
		),
		olderMessagesCursor: row.messages.length > limit && oldest ? encodeHistoryCursor(oldest) : null,
	};
}

function authorRow(
	person: { id: string; name: string; image: string | null } | null,
	author: Pick<schema.AgentRow, "id" | "name" | "handle" | "color" | "face"> | null,
): ParticipantRow {
	return {
		userId: person?.id ?? null,
		userName: person?.name ?? null,
		userImage: person?.image ?? null,
		agentId: author?.id ?? null,
		agentName: author?.name ?? null,
		agentHandle: author?.handle ?? null,
		agentColor: author?.color ?? null,
		agentFace: author?.face ?? null,
	};
}

function toThreadSummary(row: schema.ThreadSummaryRow): ThreadSummary {
	return {
		content: row.content,
		sourceMessageId: row.sourceMessageId,
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The oldest message on a page, as an opaque token the client sends back for the next page. */
function encodeHistoryCursor(row: Pick<schema.MessageRow, "createdAt" | "id">): string {
	return Buffer.from(`${row.createdAt.toISOString()}\n${row.id}`).toString("base64url");
}

function decodeHistoryCursor(
	cursor: string,
): Effect.Effect<HistoryPoint, InvalidThreadHistoryCursor> {
	const decoded = Buffer.from(cursor, "base64url").toString();
	const [timestamp, id, extra] = decoded.split("\n");
	const createdAt = timestamp ? new Date(timestamp) : new Date(Number.NaN);
	const wellFormed =
		extra === undefined &&
		timestamp &&
		id &&
		isUuid(id) &&
		!Number.isNaN(createdAt.getTime()) &&
		createdAt.toISOString() === timestamp &&
		Buffer.from(decoded).toString("base64url") === cursor;
	return wellFormed
		? Effect.succeed({ createdAt, id })
		: Effect.fail(new InvalidThreadHistoryCursor());
}

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

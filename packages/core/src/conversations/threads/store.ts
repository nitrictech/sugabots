import type {
	Thread,
	ThreadDetails,
	ThreadHistoryQuery,
	ThreadSummary,
	ThreadUsage,
} from "@sugabots/contracts";
import { DEFAULT_THREAD_HISTORY_LIMIT } from "@sugabots/contracts";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, type Executor, query } from "../../database/database.ts";
import { isUuid } from "../../database/ids.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	message,
	routineExecution,
	thread,
	threadSummary,
	turn,
	user,
} from "../../database/schema.ts";
import { podStandingFor, reachesPod } from "../../workspaces/access.ts";
import {
	findRunnableSystemAgent,
	SUMMARISE_SYSTEM_AGENT,
} from "../../workspaces/agents/system-agents.ts";
import type { PodPermission } from "../../workspaces/permissions.ts";
import { hasPendingResponseJob } from "../jobs/queue.ts";
import { findRoutineExecutionId, toRoutineExecution } from "../routines/execution.ts";
import { loadCrew, loadParticipants, participantColumns, toMessage } from "./participants.ts";
import { loadPlacedParts } from "./placed-parts.ts";
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

		getVisible: (threadId, userId, history = { limit: DEFAULT_THREAD_HISTORY_LIMIT }) =>
			Effect.gen(function* () {
				const visible = yield* query((db) => visibleThread(db, threadId, userId));
				if (!visible) {
					return undefined;
				}
				// Decoded after the visibility check, so a bad cursor cannot be used
				// to tell a hidden thread from a missing one.
				const before = history.cursor ? yield* decodeHistoryCursor(history.cursor) : undefined;
				return yield* query((db) =>
					loadDetails(db, visible, userId, { limit: history.limit, before }),
				);
			}),
	};
}

/** Where a history page starts: the message the previous page ended on. */
interface HistoryPoint {
	createdAt: Date;
	id: string;
}

const loadDetails = Effect.fn("ThreadStore.loadDetails")(function* (
	db: Executor,
	threadRow: schema.ThreadRow,
	userId: string,
	history: { limit: number; before?: HistoryPoint } = { limit: DEFAULT_THREAD_HISTORY_LIMIT },
) {
	const participants = yield* loadParticipants(db, threadRow.id);
	const crew = yield* loadCrew(db, { id: threadRow.podId, workspaceId: threadRow.workspaceId });

	// One more than the page, so we know whether an older page exists without
	// a second count query.
	const { before } = history;
	const page = yield* db
		.select({
			message,
			failure: turn.error,
			...participantColumns,
		})
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		// A failed reply's reason lives on its turn.
		.leftJoin(turn, eq(turn.id, message.turnId))
		.where(
			and(
				eq(message.threadId, threadRow.id),
				before
					? or(
							lt(message.createdAt, before.createdAt),
							and(eq(message.createdAt, before.createdAt), lt(message.id, before.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(history.limit + 1);
	const hasOlder = page.length > history.limit;
	const messages = page.slice(0, history.limit).reverse();
	const oldest = messages[0]?.message;
	const placed = yield* loadPlacedParts(
		db,
		messages.map(({ message: row }) => row.id),
	);

	const [activeTurn] = yield* db
		.select({ id: turn.id })
		.from(turn)
		.where(and(eq(turn.threadId, threadRow.id), inArray(turn.status, ["running", "waiting"])))
		.orderBy(desc(turn.startedAt), desc(turn.id))
		.limit(1);
	const [summaryRow] = yield* db
		.select()
		.from(threadSummary)
		.where(eq(threadSummary.threadId, threadRow.id))
		.limit(1);
	const [pending] = yield* db
		.select({ running: hasPendingResponseJob(sql`${threadRow.id}::uuid`) })
		.from(thread)
		.where(eq(thread.id, threadRow.id));
	const [execution] =
		threadRow.type === "routine"
			? yield* db
					.select()
					.from(routineExecution)
					.where(eq(routineExecution.threadId, threadRow.id))
					.limit(1)
			: [];

	const routineExecutionId = yield* findRoutineExecutionId(db, threadRow.id);
	// A thread whose pod has gone is a thread nobody may decide anything in,
	// which is what a standing nobody holds says.
	const standing = yield* podStandingFor(db, threadRow.podId, userId);
	const may = (permission: PodPermission) => standing?.may(permission) ?? false;

	return {
		thread: toThread(threadRow, pending?.running ?? false),
		// What this person may do with the approvals this thread raises, decided
		// once here so the conversation does not have to work it out from a role.
		capabilities: {
			approveToolCalls: may(routineExecutionId ? "approval.routine.decide" : "approval.decide"),
			alwaysAllowToolCalls: may("approval.alwaysAllow"),
		},
		activeTurnId: activeTurn?.id ?? null,
		routineExecution: execution ? toRoutineExecution(execution) : null,
		participants,
		crew,
		messages: messages.map(({ message: row, failure, ...author }) =>
			toMessage(row, author, placed(row.id), failure),
		),
		olderMessagesCursor: hasOlder && oldest ? encodeHistoryCursor(oldest) : null,
		summary: summaryRow ? toThreadSummary(summaryRow) : null,
		summaryEnabled: yield* scribeIsSetUp(db, threadRow.workspaceId),
		usage: yield* loadUsage(db, threadRow),
	};
});

/**
 * Whether the workspace has chosen a model for its Scribe, which is what
 * decides whether summaries happen at all.
 */
const scribeIsSetUp = Effect.fn("ThreadStore.scribeIsSetUp")(function* (
	db: Executor,
	workspaceId: string,
) {
	return (yield* findRunnableSystemAgent(db, workspaceId, SUMMARISE_SYSTEM_AGENT)) !== undefined;
});

/**
 * What the thread has cost, summed over its own turns and its system agents' turns
 * in child threads, since those tokens were spent because of this conversation.
 *
 * A total is reported only when every accounted turn measured it. A partial
 * sum would look like a smaller number rather than an unknown one, and the
 * product rule is that an unknown cost is shown as unavailable, never invented.
 */
const loadUsage = Effect.fn("ThreadStore.loadUsage")(function* (
	db: Executor,
	threadRow: schema.ThreadRow,
) {
	const measured = (field: string) =>
		sql<number>`count(${turn.usage} ->> ${field}) filter (where ${turn.usage} is not null)`.mapWith(
			Number,
		);
	const summed = (field: string) => sql<string | null>`sum((${turn.usage} ->> ${field})::numeric)`;

	const [totals] = yield* db
		.select({
			accountedTurns: sql<number>`count(*) filter (where ${turn.usage} is not null)`.mapWith(
				Number,
			),
			modelCallsMeasured: measured("modelCalls"),
			modelCalls: summed("modelCalls"),
			inputTokensMeasured: measured("inputTokens"),
			inputTokens: summed("inputTokens"),
			outputTokensMeasured: measured("outputTokens"),
			outputTokens: summed("outputTokens"),
			totalTokensMeasured: measured("totalTokens"),
			totalTokens: summed("totalTokens"),
			reportedCostMeasured:
				sql<number>`count(${turn.reportedCost}) filter (where ${turn.usage} is not null)`.mapWith(
					Number,
				),
			reportedCost: sql<
				string | null
			>`sum(${turn.reportedCost}) filter (where ${turn.usage} is not null)`,
		})
		.from(turn)
		.innerJoin(thread, eq(thread.id, turn.threadId))
		.where(or(eq(thread.id, threadRow.id), eq(thread.parentThreadId, threadRow.id)));

	const [latest] = yield* db
		.select({ usedTokens: turn.contextTokens, capacityTokens: turn.contextCapacity })
		.from(turn)
		.where(and(eq(turn.threadId, threadRow.id), isNotNull(turn.contextTokens)))
		.orderBy(desc(turn.startedAt), desc(turn.id))
		.limit(1);

	const accounted = totals?.accountedTurns ?? 0;
	const whenAllMeasured = (total: string | null | undefined, measuredCount: number | undefined) =>
		accounted === 0 || measuredCount !== accounted || total == null ? null : Number(total);

	return {
		modelCalls:
			whenAllMeasured(totals?.modelCalls, totals?.modelCallsMeasured) ??
			(accounted === 0 ? 0 : null),
		inputTokens: whenAllMeasured(totals?.inputTokens, totals?.inputTokensMeasured),
		outputTokens: whenAllMeasured(totals?.outputTokens, totals?.outputTokensMeasured),
		totalTokens: whenAllMeasured(totals?.totalTokens, totals?.totalTokensMeasured),
		reportedCost: whenAllMeasured(totals?.reportedCost, totals?.reportedCostMeasured),
		latestContext:
			latest?.usedTokens != null
				? { usedTokens: latest.usedTokens, capacityTokens: latest.capacityTokens }
				: null,
	} satisfies ThreadUsage;
});

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

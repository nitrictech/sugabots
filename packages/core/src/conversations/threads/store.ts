import type {
	Thread,
	ThreadDetails,
	ThreadHistoryQuery,
	ThreadSummary,
	ThreadUsage,
} from "@sugabots/contracts";
import { DEFAULT_THREAD_HISTORY_LIMIT } from "@sugabots/contracts";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { modelAttempt, modelAttemptObservation } from "../../accounting/sql.ts";
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
import {
	loadCrew,
	loadParticipants,
	loadRecentParticipants,
	participantColumns,
	toMessage,
} from "./participants.ts";
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

		getVisible: Effect.fn("ThreadStore.getVisible")(function* (
			threadId: string,
			userId: string,
			history: ThreadHistoryQuery = { limit: DEFAULT_THREAD_HISTORY_LIMIT },
		) {
			yield* Effect.annotateCurrentSpan("thread.id", threadId);
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
		recentParticipants: yield* loadRecentParticipants(db, threadRow.id),
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
 * What the thread has cost, summed over its own model requests and those made
 * in its child threads, since those tokens were spent because of this
 * conversation.
 *
 * Requests are read from the ledger. Turns from before it existed kept their
 * usage on the turn row instead, and a turn written since never does, so the
 * two sources cannot count the same request twice.
 *
 * A total is reported only when every accounted request measured it. A partial
 * sum would look like a smaller number rather than an unknown one, and the
 * product rule is that an unknown cost is shown as unavailable, never invented.
 */
const loadUsage = Effect.fn("ThreadStore.loadUsage")(function* (
	db: Executor,
	threadRow: schema.ThreadRow,
) {
	const inConversation = or(eq(thread.id, threadRow.id), eq(thread.parentThreadId, threadRow.id));
	const legacy = yield* loadTurnRowUsage(db, inConversation);
	const ledger = yield* loadLedgerUsage(db, inConversation);

	const [latest] = yield* db
		.select({ usedTokens: turn.contextTokens, capacityTokens: turn.contextCapacity })
		.from(turn)
		.where(and(eq(turn.threadId, threadRow.id), isNotNull(turn.contextTokens)))
		.orderBy(desc(turn.startedAt), desc(turn.id))
		.limit(1);

	const accounted = legacy.accounted + ledger.accounted;
	const whenAllMeasured = (measure: keyof Omit<UsageTotals, "accounted">) => {
		const measured = legacy[measure].measured + ledger[measure].measured;
		const sums = [legacy[measure].sum, ledger[measure].sum].filter((sum) => sum !== null);
		return accounted === 0 || measured !== accounted || sums.length === 0
			? null
			: sums.reduce((total, sum) => total + Number(sum), 0);
	};

	return {
		modelCalls: whenAllMeasured("modelCalls") ?? (accounted === 0 ? 0 : null),
		inputTokens: whenAllMeasured("inputTokens"),
		outputTokens: whenAllMeasured("outputTokens"),
		totalTokens: whenAllMeasured("totalTokens"),
		reportedCost: whenAllMeasured("reportedCost"),
		latestContext:
			latest?.usedTokens != null
				? { usedTokens: latest.usedTokens, capacityTokens: latest.capacityTokens }
				: null,
	} satisfies ThreadUsage;
});

/** How many accounted things measured a quantity, and their sum. */
interface Measure {
	measured: number;
	sum: string | null;
}

interface UsageTotals {
	accounted: number;
	modelCalls: Measure;
	inputTokens: Measure;
	outputTokens: Measure;
	totalTokens: Measure;
	reportedCost: Measure;
}

const noUsage: UsageTotals = {
	accounted: 0,
	modelCalls: { measured: 0, sum: null },
	inputTokens: { measured: 0, sum: null },
	outputTokens: { measured: 0, sum: null },
	totalTokens: { measured: 0, sum: null },
	reportedCost: { measured: 0, sum: null },
};

const measure = (measured: SQL<unknown>, sum: SQL<unknown>) => ({
	measured: sql<number>`${measured}`.mapWith(Number),
	sum: sql<string | null>`${sum}`,
});

/** Usage turns recorded on their own row, before the ledger. Each turn counts once. */
const loadTurnRowUsage = Effect.fn("ThreadStore.loadTurnRowUsage")(function* (
	db: Executor,
	inConversation: SQL | undefined,
) {
	const counted = sql`${turn.usage} is not null`;
	const field = (name: string) =>
		measure(
			sql`count(${turn.usage} ->> ${name}) filter (where ${counted})`,
			sql`sum((${turn.usage} ->> ${name})::numeric)`,
		);
	const [totals] = yield* db
		.select({
			accounted: sql<number>`count(*) filter (where ${counted})`.mapWith(Number),
			modelCalls: field("modelCalls"),
			inputTokens: field("inputTokens"),
			outputTokens: field("outputTokens"),
			totalTokens: field("totalTokens"),
			reportedCost: measure(
				sql`count(${turn.reportedCost}) filter (where ${counted})`,
				sql`sum(${turn.reportedCost}) filter (where ${counted})`,
			),
		})
		.from(turn)
		.innerJoin(thread, eq(thread.id, turn.threadId))
		.where(inConversation);
	return totals ?? noUsage;
});

/**
 * Usage from the ledger, one request per attempt that measured it. A request
 * that ended before its usage arrived is left out, as a failed turn was before.
 * The ledger has no provider-reported charges, so it adds no reported cost.
 */
const loadLedgerUsage = Effect.fn("ThreadStore.loadLedgerUsage")(function* (
	db: Executor,
	inConversation: SQL | undefined,
) {
	const counter = (name: string) =>
		sql`(${modelAttemptObservation.observation} -> 'payload' -> 'evidence' -> 'counters' ->> ${name})::numeric`;
	const input = counter("inputTokens");
	const output = counter("outputTokens");
	const conversationThreads = db.select({ id: thread.id }).from(thread).where(inConversation);
	const [totals] = yield* db
		.select({
			accounted: sql<number>`count(*)`.mapWith(Number),
			modelCalls: measure(sql`count(*)`, sql`count(*)`),
			inputTokens: measure(sql`count(${input})`, sql`sum(${input})`),
			outputTokens: measure(sql`count(${output})`, sql`sum(${output})`),
			totalTokens: measure(sql`count(${input} + ${output})`, sql`sum(${input} + ${output})`),
			reportedCost: measure(sql`0`, sql`null`),
		})
		.from(modelAttempt)
		.innerJoin(
			modelAttemptObservation,
			and(
				eq(modelAttemptObservation.attemptId, modelAttempt.attemptId),
				eq(modelAttemptObservation.type, "usage"),
				sql`not exists (
					select 1 from ${modelAttemptObservation} as correction
					where correction.supersedes_observation_id = ${modelAttemptObservation.observationId}
				)`,
			),
		)
		.where(inArray(modelAttempt.threadId, conversationThreads));
	return totals ?? noUsage;
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

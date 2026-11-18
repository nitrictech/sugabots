import type { Run } from "@sugabots/contracts";
import { eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { Effect } from "effect";
import { type Executor, query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import {
	automationRun,
	conversationRead,
	message,
	placedConversation,
} from "../../database/schema.ts";
import { lineageOf } from "../repository/tree.ts";

/**
 * A run as the API describes it, listed in the conversation `rootConversationId`,
 * which `posted` a result or not (see `resultPosted`).
 */
export function toRun(row: schema.RunRow, rootConversationId: string, posted: boolean): Run {
	return {
		id: row.id,
		automationId: row.automationId,
		workspaceId: row.workspaceId,
		botId: row.botId,
		conversationId: row.conversationId,
		rootConversationId,
		automationName: row.automationName,
		instructions: row.instructions,
		trigger: row.trigger,
		state: row.state,
		error: row.error,
		posted,
		acceptedAt: row.acceptedAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

/**
 * Whether the run `runId` posted a result, as a SQL condition. Every
 * result is posted in the automation's feed, whatever else it goes to.
 */
export const resultPosted = (runId: SQLWrapper) =>
	sql<boolean>`exists (select 1 from ${message} where ${message.runId} = ${runId})`;

/**
 * The automation run a conversation belongs to, found through its ancestors, as a
 * scalar subquery: a collaboration an automation's bot starts is part of the run.
 */
export const runIdOf = (conversationId: SQLWrapper) => sql<string | null>`(
	select execution.id
	from ${automationRun} execution
	join ${lineageOf(conversationId)} as lineage on lineage.id = execution.conversation_id
	limit 1
)`;

export const findRunId = Effect.fn("Run.findRunId")(function* (
	db: Executor,
	conversationId: string,
) {
	const rows = yield* db.execute<{ id: string | null }>(
		sql`select ${runIdOf(sql`${conversationId}`)} as id`,
		"objects",
	);
	return rows[0]?.id ?? undefined;
});

/**
 * lockAutomationSettlement holds the settlement lock of the automation run
 * `runId` until the transaction ends. Settling the run holds it, so an
 * answer read under it about whether the run still takes work stands until
 * the transaction ends.
 *
 * Lock order: only settlement, in a transaction of its own after the events
 * that trigger it commit, and a transaction admitting work into the run
 * (`automationAcceptsWork`) take this lock, both before any row they lock.
 * Settlement skips the running turns, collaborations and waiting lane
 * requests another transaction holds; that transaction's own events settle
 * the run again.
 */
export const lockAutomationSettlement = (runId: string) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`automation-settle:${runId}`}, 0))`,
		),
	).pipe(Effect.asVoid);

/**
 * lockAutomationSettlementOf holds the settlement lock of the automation run the
 * conversation `conversationId` belongs to, if any, as `lockAutomationSettlement` does, and
 * returns the run's id.
 */
export const lockAutomationSettlementOf = Effect.fn("Run.lockAutomationSettlementOf")(function* (
	conversationId: string,
) {
	const runId = yield* query((db) => findRunId(db, conversationId));
	if (runId) yield* lockAutomationSettlement(runId);
	return runId;
});

/**
 * automationAcceptsWork reports whether the automation run the conversation `conversationId`
 * belongs to still takes turns and tool calls: it is queued or running, and
 * nothing has started ending it. A conversation outside any run takes work. The
 * run's settlement lock is held until the transaction ends, so the answer
 * stands while the caller admits the work.
 */
export const automationAcceptsWork = Effect.fn("Run.automationAcceptsWork")(function* (
	conversationId: string,
) {
	const runId = yield* lockAutomationSettlementOf(conversationId);
	if (!runId) return true;
	const [execution] = yield* query((db) =>
		db
			.select({
				state: automationRun.state,
				pendingTerminalState: automationRun.pendingTerminalState,
			})
			.from(automationRun)
			.where(eq(automationRun.id, runId))
			.limit(1),
	);
	return (
		execution !== undefined &&
		execution.pendingTerminalState === null &&
		(execution.state === "queued" || execution.state === "running")
	);
});

/**
 * Whether the latest run of the automation `automationId` failed and `userId` has
 * not opened the automation's feed since it ended, as a value for a query.
 * Opening the conversation reads it through its newest run's end.
 */
export function latestRunFailedUnseen(automationId: SQLWrapper, userId: string): SQL<boolean> {
	return sql<boolean>`coalesce((
		select ${automationRun.state} = 'failed' and not exists (
			select 1 from ${conversationRead} join ${placedConversation} on ${placedConversation.id} = ${conversationRead.conversationId}
			where ${placedConversation.automationId} = ${automationId}
				and ${conversationRead.userId} = ${userId}
				and ${conversationRead.readThrough} >= ${automationRun.finishedAt}
		)
		from ${automationRun}
		where ${automationRun.automationId} = ${automationId}
		order by ${automationRun.acceptedAt} desc, ${automationRun.id} desc
		limit 1
	), false)`;
}

/** Whether the latest run of the automation `automationId` failed, as a value for a query. */
export function latestRunFailed(automationId: SQLWrapper): SQL<boolean> {
	return sql<boolean>`coalesce((
		select ${automationRun.state} = 'failed' from ${automationRun}
		where ${automationRun.automationId} = ${automationId}
		order by ${automationRun.acceptedAt} desc, ${automationRun.id} desc
		limit 1
	), false)`;
}

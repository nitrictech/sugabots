import type { RoutineExecution } from "@sugabots/contracts";
import { eq, type SQLWrapper, sql } from "drizzle-orm";
import { Effect } from "effect";
import { type Executor, query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { routineExecution, thread } from "../../database/schema.ts";

export function toRoutineExecution(row: schema.RoutineExecutionRow): RoutineExecution {
	return {
		id: row.id,
		routineId: row.routineId,
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		threadId: row.threadId,
		routineName: row.routineName,
		instructions: row.instructions,
		trigger: row.trigger,
		state: row.state,
		error: row.error,
		acceptedAt: row.acceptedAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

/**
 * The routine execution a thread belongs to, found through its ancestors, as a
 * scalar subquery: a collaboration a routine's agent starts is part of the run.
 */
export const routineExecutionIdOf = (threadId: SQLWrapper) => sql<string | null>`(
	with recursive ancestors as (
		select id, parent_thread_id from ${thread} where id = ${threadId}
		union all
		select parent.id, parent.parent_thread_id
		from ${thread} parent
		join ancestors child on child.parent_thread_id = parent.id
	)
	select execution.id
	from ${routineExecution} execution
	join ancestors on ancestors.id = execution.thread_id
	limit 1
)`;

export const findRoutineExecutionId = Effect.fn("RoutineExecution.findRoutineExecutionId")(
	function* (db: Executor, threadId: string) {
		const rows = yield* db.execute<{ id: string | null }>(
			sql`select ${routineExecutionIdOf(sql`${threadId}`)} as id`,
			"objects",
		);
		return rows[0]?.id ?? undefined;
	},
);

/**
 * lockRoutineSettlement holds the settlement lock of the routine run
 * `executionId` until the transaction ends. Settling the run holds it, so an
 * answer read under it about whether the run still takes work stands until
 * the transaction ends.
 *
 * Lock order: a transaction that admits work into a run, or ends one of its
 * waiting turns, takes this lock before it locks the turn or tool call. Other
 * writers lock their rows first and reach this lock afterwards, when
 * settlement reacts to their events inside their transaction; so settlement
 * never waits for their rows, and skips the running turns, collaborations
 * and waiting lane requests another transaction holds. That transaction's own
 * events settle the run again.
 */
export const lockRoutineSettlement = (executionId: string) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`routine-settle:${executionId}`}, 0))`,
		),
	).pipe(Effect.asVoid);

/**
 * lockRoutineSettlementOf holds the settlement lock of the routine run the
 * thread `threadId` belongs to, if any, as `lockRoutineSettlement` does, and
 * returns the run's id.
 */
export const lockRoutineSettlementOf = Effect.fn("RoutineExecution.lockRoutineSettlementOf")(
	function* (threadId: string) {
		const executionId = yield* query((db) => findRoutineExecutionId(db, threadId));
		if (executionId) yield* lockRoutineSettlement(executionId);
		return executionId;
	},
);

/**
 * routineAcceptsWork reports whether the routine run the thread `threadId`
 * belongs to still takes turns and tool calls: it is queued or running, and
 * nothing has started ending it. A thread outside any run takes work. The
 * run's settlement lock is held until the transaction ends, so the answer
 * stands while the caller admits the work.
 */
export const routineAcceptsWork = Effect.fn("RoutineExecution.routineAcceptsWork")(function* (
	threadId: string,
) {
	const executionId = yield* lockRoutineSettlementOf(threadId);
	if (!executionId) return true;
	const [execution] = yield* query((db) =>
		db
			.select({
				state: routineExecution.state,
				pendingTerminalState: routineExecution.pendingTerminalState,
			})
			.from(routineExecution)
			.where(eq(routineExecution.id, executionId))
			.limit(1),
	);
	return (
		execution !== undefined &&
		execution.pendingTerminalState === null &&
		(execution.state === "queued" || execution.state === "running")
	);
});

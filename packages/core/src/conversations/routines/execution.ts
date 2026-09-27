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

export const routineSettlementLockKey = (executionId: string) => `routine-settle:${executionId}`;

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
 * routineRejectsTurns reports whether the routine run `executionId` takes no
 * more turns: it is gone, it has ended, or it has been told to end. It holds
 * the run's settlement lock until the transaction ends, so the answer stays
 * true while the caller acts on it.
 */
export const routineRejectsTurns = (executionId: string) =>
	Effect.gen(function* () {
		const lockKey = routineSettlementLockKey(executionId);
		yield* query((db) =>
			db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
		);
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
		if (!execution) return true;
		return (
			execution.pendingTerminalState !== null ||
			execution.state === "completed" ||
			execution.state === "failed" ||
			execution.state === "cancelled"
		);
	});

/**
 * threadRejectsTurns reports whether the routine run the thread belongs to,
 * if any, takes no more turns, holding its settlement lock as
 * `routineRejectsTurns` does.
 */
export const threadRejectsTurns = (threadId: string) =>
	Effect.flatMap(
		query((db) => findRoutineExecutionId(db, threadId)),
		(executionId) => (executionId ? routineRejectsTurns(executionId) : Effect.succeed(false)),
	);

import type { RoutineExecution } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
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

export const findRoutineExecutionId = Effect.fn("RoutineExecution.findRoutineExecutionId")(
	function* (db: Executor, threadId: string) {
		const rows = yield* db.execute<{ id: string }>(
			sql`
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
	`,
			"objects",
		);
		return rows[0]?.id;
	},
);

import type { Routine } from "@sugabots/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type * as schema from "../../database/schema.ts";
import { routine } from "../../database/schema.ts";

/** A routine on an agent in a workspace. */
export interface Scope {
	readonly workspaceId: string;
	readonly agentId: string;
	readonly routineId: string;
}

/** The routine `scope` names, as a condition on `routine`, unless it has been removed. */
export const inScope = (scope: Scope) =>
	and(
		eq(routine.id, scope.routineId),
		eq(routine.workspaceId, scope.workspaceId),
		eq(routine.agentId, scope.agentId),
		isNull(routine.deletedAt),
	);

export function toRoutine(row: schema.RoutineRow): Routine {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		name: row.name,
		instructions: row.instructions,
		trigger:
			row.triggerKind === "cron"
				? {
						kind: "cron",
						expression: row.cronExpression ?? "",
						timezone: row.cronTimezone ?? "",
						nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null,
					}
				: { kind: "webhook" },
		state: row.state,
		createdById: row.createdById,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

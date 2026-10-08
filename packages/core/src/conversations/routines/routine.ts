import type { Routine } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { Authorization } from "../../authorization/authorization.ts";
import type { PodPermission } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";
import { routine } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";

/** A routine, by the crew agent it belongs to and its own id. */
export interface OnAgent {
	agentId: string;
	routineId: string;
}

/** A routine on an agent in a workspace. */
export interface Scope {
	readonly workspaceId: string;
	readonly agentId: string;
	readonly routineId: string;
}

/**
 * The scope of the routine named, once the current actor may take
 * `permission` on its agent.
 */
export const scopeOf = (
	authorization: Authorization.Interface,
	{ agentId, routineId }: OnAgent,
	permission: PodPermission,
) =>
	Effect.map(
		authorization.agent(agentId, permission),
		({ agent }): Scope => ({ workspaceId: agent.workspaceId, agentId: agent.id, routineId }),
	);

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
		results: row.results,
		createdById: row.createdById,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export class RoutineNotFound extends Data.TaggedError("RoutineNotFound") implements UserFacing {
	get userMessage() {
		return userText`No such Routine`;
	}
}

export class RoutineTriggerConflict
	extends Data.TaggedError("RoutineTriggerConflict")
	implements UserFacing
{
	get userMessage() {
		return userText`That trigger identity was already used with different data`;
	}
}

export class RoutineTriggerRejected
	extends Data.TaggedError("RoutineTriggerRejected")
	implements UserFacing
{
	get userMessage() {
		return userText`That Routine cannot accept this trigger`;
	}
}

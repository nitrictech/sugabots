import {
	MAX_ROUTINE_TRIGGERS,
	MIN_WEBHOOK_SECRET_CHARACTERS,
	type Routine,
	type RoutineTrigger,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { Authorization } from "../../authorization/authorization.ts";
import type { PodPermission } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { routine, routineTrigger } from "../../database/schema.ts";
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

export function toRoutine(
	row: schema.RoutineRow,
	triggers: readonly schema.RoutineTriggerRow[],
): Routine {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		name: row.name,
		instructions: row.instructions,
		triggers: triggers.map(toTrigger),
		state: row.state,
		results: row.results,
		createdById: row.createdById,
		createdByAgentId: row.createdByAgentId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export function toTrigger(row: schema.RoutineTriggerRow): RoutineTrigger {
	const { settings } = row;
	return settings.kind === "cron"
		? { id: row.id, ...settings, nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null }
		: { id: row.id, ...settings };
}

/** The triggers of each of `routineIds`, in the order they were added. */
export const triggersOf = (routineIds: readonly string[]) =>
	Effect.map(
		routineIds.length === 0
			? Effect.succeed([])
			: query((db) =>
					db
						.select()
						.from(routineTrigger)
						.where(inArray(routineTrigger.routineId, [...routineIds]))
						.orderBy(asc(routineTrigger.createdAt), asc(routineTrigger.id)),
				),
		(rows) => Map.groupBy(rows, (row) => row.routineId),
	);

/** A routine's row as the API shows it, with its triggers read alongside. */
export const routineWithTriggers = (row: schema.RoutineRow) =>
	Effect.map(triggersOf([row.id]), (triggers) => toRoutine(row, triggers.get(row.id) ?? []));

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

/** A secret made up for a generic webhook too short to be hard to guess. */
export class WebhookSecretTooShort
	extends Data.TaggedError("WebhookSecretTooShort")
	implements UserFacing
{
	get userMessage() {
		return userText`A secret needs at least ${MIN_WEBHOOK_SECRET_CHARACTERS} characters`;
	}
}

export class RoutineDeliveryIdTooLong
	extends Data.TaggedError("RoutineDeliveryIdTooLong")
	implements UserFacing
{
	get userMessage() {
		return userText`The delivery's id is too long`;
	}
}

/** A repository trigger for a repository the routine's agent's pod doesn't have. */
export class RoutineRepositoryNotInPod
	extends Data.TaggedError("RoutineRepositoryNotInPod")
	implements UserFacing
{
	get userMessage() {
		return userText`That repository isn't one of the bot's pod's. Add it in the pod's settings first.`;
	}
}

export class RoutineTriggerNotFound
	extends Data.TaggedError("RoutineTriggerNotFound")
	implements UserFacing
{
	get userMessage() {
		return userText`The routine has no such trigger. It may have been removed.`;
	}
}

/** A trigger written as another kind than it is: a trigger keeps its kind, and another is added instead. */
export class RoutineTriggerKindChanged
	extends Data.TaggedError("RoutineTriggerKindChanged")
	implements UserFacing
{
	get userMessage() {
		return userText`A trigger keeps its kind. Add a trigger of the other kind instead, and remove this one.`;
	}
}

export class TooManyRoutineTriggers
	extends Data.TaggedError("TooManyRoutineTriggers")
	implements UserFacing
{
	get userMessage() {
		return userText`A routine can have at most ${MAX_ROUTINE_TRIGGERS} triggers.`;
	}
}

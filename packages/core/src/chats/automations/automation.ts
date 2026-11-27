export {
	AutomationDeliveryIdTooLong,
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	AutomationTriggerRejected,
	TooManyAutomationTriggers,
	WebhookDeliveryIdHeaderRejected,
	WebhookSecretTooShort,
} from "@sugabots/contracts/errors/automations";

import type { Automation, AutomationTrigger, AutomationTriggerInput } from "@sugabots/contracts";
import { TriggerSetInSettings } from "@sugabots/contracts/errors/automations";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { automation, automationTrigger } from "../../database/schema.ts";

/** A routine as it is written: when it repeats, and in which timezone. */
export type RoutineInput = Extract<AutomationTriggerInput, { kind: "routine" }>;

/** An automation of a project in a workspace. */
export interface Scope {
	readonly workspaceId: string;
	readonly projectId: string;
	readonly automationId: string;
}

/** The automation `scope` names, as a condition on `automation`, unless it has been removed. */
export const inScope = (scope: Scope) =>
	and(
		eq(automation.id, scope.automationId),
		eq(automation.workspaceId, scope.workspaceId),
		eq(automation.projectId, scope.projectId),
		isNull(automation.deletedAt),
	);

/**
 * Holds the automation's trigger lock until the transaction ends, so its
 * triggers are accepted one at a time and none lands on an automation being
 * removed or having its secret replaced.
 */
export const lockTriggers = (automationId: string) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`automation-trigger:${automationId}`}, 0))`,
		),
	);

export const stateWithPendingPause = (
	row: Pick<schema.AutomationRow, "state" | "pauseAfterFailuresPendingAt">,
): Automation["state"] => (row.pauseAfterFailuresPendingAt !== null ? "paused" : row.state);

export function toAutomation(
	row: schema.AutomationRow,
	triggers: readonly schema.AutomationTriggerRow[],
): Automation {
	const state = stateWithPendingPause(row);
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		name: row.name,
		instructions: row.instructions,
		triggers: triggers.map((trigger) => toTrigger(trigger, state === "enabled")),
		state,
		pausedAfterFailures:
			row.pausedAfterFailuresAt !== null || row.pauseAfterFailuresPendingAt !== null,
		createdById: row.createdById,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function toTrigger(row: schema.AutomationTriggerRow, enabled: boolean): AutomationTrigger {
	const { settings } = row;
	return settings.kind === "routine"
		? {
				id: row.id,
				...settings,
				nextScheduledAt: enabled ? (row.nextScheduledAt?.toISOString() ?? null) : null,
			}
		: { id: row.id, ...settings };
}

/** The triggers of each of `automationIds`, in the order they were added. */
export const triggersOf = (automationIds: readonly string[]) =>
	Effect.map(
		automationIds.length === 0
			? Effect.succeed([])
			: query((db) =>
					db
						.select()
						.from(automationTrigger)
						.where(inArray(automationTrigger.automationId, [...automationIds]))
						.orderBy(asc(automationTrigger.createdAt), asc(automationTrigger.id)),
				),
		(rows) => Map.groupBy(rows, (row) => row.automationId),
	);

export const findSoleRoutineId = (automationId: string) =>
	Effect.gen(function* () {
		const [only, another] = (yield* triggersOf([automationId])).get(automationId) ?? [];
		if (another || (only && only.settings.kind !== "routine")) {
			return yield* new TriggerSetInSettings();
		}
		return only?.id ?? null;
	});

/** An automation's row as the API shows it, with its triggers read alongside. */
export const automationWithTriggers = (row: schema.AutomationRow) =>
	Effect.map(triggersOf([row.id]), (triggers) => toAutomation(row, triggers.get(row.id) ?? []));

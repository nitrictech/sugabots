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
import { type DomainError, userText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Effect, ErrorReporter, Schema } from "effect";
import type { Authorization } from "../../authorization/authorization.ts";
import type { ProjectPermission } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { automation, automationTrigger } from "../../database/schema.ts";

/** An automation, by the project it belongs to and its own id. */
export interface InProject {
	projectId: string;
	automationId: string;
}

/** A routine as it is written: when it repeats, and in which timezone. */
export type RoutineInput = Extract<AutomationTriggerInput, { kind: "routine" }>;

/** An automation of a project in a workspace. */
export interface Scope {
	readonly workspaceId: string;
	readonly projectId: string;
	readonly automationId: string;
}

/**
 * The scope of the automation named, once the current actor may take
 * `permission` in its project.
 */
export const scopeOf = (
	authorization: Authorization.Interface,
	{ projectId, automationId }: InProject,
	permission: ProjectPermission,
) =>
	Effect.map(
		authorization.project(projectId, permission),
		({ project }): Scope => ({
			workspaceId: project.workspaceId,
			projectId: project.id,
			automationId,
		}),
	);

/** The automation `scope` names, as a condition on `automation`, unless it has been removed. */
export const inScope = (scope: Scope) =>
	and(
		eq(automation.id, scope.automationId),
		eq(automation.workspaceId, scope.workspaceId),
		eq(automation.projectId, scope.projectId),
		isNull(automation.deletedAt),
	);

export function toAutomation(
	row: schema.AutomationRow,
	triggers: readonly schema.AutomationTriggerRow[],
): Automation {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		projectId: row.projectId,
		name: row.name,
		instructions: row.instructions,
		triggers: triggers.map(toTrigger),
		state: row.state,
		pausedAfterFailures: row.pausedAfterFailuresAt !== null,
		createdById: row.createdById,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function toTrigger(row: schema.AutomationTriggerRow): AutomationTrigger {
	const { settings } = row;
	return settings.kind === "routine"
		? { id: row.id, ...settings, nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null }
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

/** An automation's row as the API shows it, with its triggers read alongside. */
export const automationWithTriggers = (row: schema.AutomationRow) =>
	Effect.map(triggersOf([row.id]), (triggers) => toAutomation(row, triggers.get(row.id) ?? []));

/**
 * A routine changed only while it is all that starts its automation, as a bot
 * changes one: one with another routine or a trigger has those set up in
 * settings.
 */
export class TriggerSetInSettings
	extends Schema.TaggedError<TriggerSetInSettings>()("TriggerSetInSettings", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The automation has another routine or a trigger, set up in settings";
	}
	get userMessage() {
		return userText`That automation has more than one routine, or a trigger, which only its Automations page can change. Its name, instructions and whether it is paused can still be changed here.`;
	}
}

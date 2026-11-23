import {
	type Automation,
	type AutomationTrigger,
	type AutomationTriggerInput,
	MAX_AUTOMATION_TRIGGERS,
	MIN_WEBHOOK_SECRET_CHARACTERS,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import type { Authorization } from "../../authorization/authorization.ts";
import type { ProjectPermission } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { automation, automationTrigger } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";

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

export class AutomationNotFound
	extends Data.TaggedError("AutomationNotFound")
	implements UserFacing
{
	get userMessage() {
		return userText`No such automation`;
	}
}

export class AutomationTriggerConflict
	extends Data.TaggedError("AutomationTriggerConflict")
	implements UserFacing
{
	get userMessage() {
		return userText`That trigger identity was already used with different data`;
	}
}

export class AutomationTriggerRejected
	extends Data.TaggedError("AutomationTriggerRejected")
	implements UserFacing
{
	get userMessage() {
		return userText`That automation cannot accept this trigger`;
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

export class WebhookDeliveryIdHeaderRejected
	extends Data.TaggedError("WebhookDeliveryIdHeaderRejected")
	implements UserFacing
{
	get userMessage() {
		return userText`The delivery ID header must be different from an authentication header`;
	}
}

export class AutomationDeliveryIdTooLong
	extends Data.TaggedError("AutomationDeliveryIdTooLong")
	implements UserFacing
{
	get userMessage() {
		return userText`The delivery's id is too long`;
	}
}

/** A repository trigger for a repository the automation's project's GitHub app doesn't work on. */
export class AutomationRepositoryNotConnected
	extends Data.TaggedError("AutomationRepositoryNotConnected")
	implements UserFacing
{
	get userMessage() {
		return userText`That repository isn't one the project's GitHub app works on. Add it to the GitHub app first.`;
	}
}

export class AutomationTriggerNotFound
	extends Data.TaggedError("AutomationTriggerNotFound")
	implements UserFacing
{
	get userMessage() {
		return userText`The automation has no such trigger. It may have been removed.`;
	}
}

/** A trigger written as another kind than it is: a trigger keeps its kind, and another is added instead. */
export class AutomationTriggerKindChanged
	extends Data.TaggedError("AutomationTriggerKindChanged")
	implements UserFacing
{
	get userMessage() {
		return userText`A trigger keeps its kind. Add a trigger of the other kind instead, and remove this one.`;
	}
}

/**
 * A routine changed only while it is all that starts its automation, as a bot
 * changes one: one with another routine or a trigger has those set up in
 * settings.
 */
export class TriggerSetInSettings
	extends Data.TaggedError("TriggerSetInSettings")
	implements UserFacing
{
	get userMessage() {
		return userText`That automation has more than one routine, or a trigger, which only its Automations page can change. Its name, instructions and whether it is paused can still be changed here.`;
	}
}

export class TooManyAutomationTriggers
	extends Data.TaggedError("TooManyAutomationTriggers")
	implements UserFacing
{
	get userMessage() {
		return userText`An automation can have at most ${MAX_AUTOMATION_TRIGGERS} triggers.`;
	}
}

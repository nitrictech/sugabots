export * as WorkspaceTimeZone from "./workspace-time-zone.ts";

import type { TimeZone, WorkspaceTimeZone as WorkspaceTimeZoneView } from "@sugabots/contracts";
import { and, countDistinct, eq, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { nextOccurrence } from "../../chats/automations/schedule.ts";
import { AutomationStore } from "../../chats/automations/store.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { automation, automationTrigger, workspace } from "../../database/schema.ts";
import {
	type InWorkspace,
	requireTimeZoneKnownToPostgres,
	TimeZoneUnknown,
} from "../membership/membership.ts";

/**
 * Where a workspace's days begin. Its automations' routines in its zone are
 * taken to follow it, so they move when it does; a routine set in any other
 * zone was chosen for that zone, and stays.
 */
export interface Interface {
	/** Takes the current actor's `workspace.update`, as changing it does. */
	readonly get: (
		input: InWorkspace,
	) => Effect.Effect<WorkspaceTimeZoneView, AuthorizationDenied, CurrentActor.Service>;
	/** Moves the workspace, and its automations' routines in its old zone, to `timeZone`. */
	readonly change: (
		input: InWorkspace & { timeZone: TimeZone },
	) => Effect.Effect<void, AuthorizationDenied | TimeZoneUnknown, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WorkspaceTimeZone",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("WorkspaceTimeZone");
	const authorization = yield* Authorization.Service;
	const automations = yield* AutomationStore.Service;

	/** Rewrites each routine in `from` to run in `to`, from now. */
	const moveRoutines = (workspaceId: string, from: string, to: TimeZone) =>
		Effect.gen(function* () {
			const schedules = yield* query((db) =>
				db
					.select({
						trigger: automationTrigger,
						projectId: automation.projectId,
						state: automation.state,
					})
					.from(automationTrigger)
					.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
					.where(and(eq(automationTrigger.workspaceId, workspaceId), inZone(from)))
					.for("update", { of: automationTrigger }),
			);
			const now = yield* DateTime.nowAsDate;
			yield* Effect.forEach(
				schedules,
				({ trigger, projectId, state }) =>
					Effect.gen(function* () {
						if (trigger.settings.kind !== "routine") return;
						const settings = { ...trigger.settings, timezone: to };
						yield* automations.updateTrigger(
							{ workspaceId, projectId, automationId: trigger.automationId },
							trigger.id,
							{
								settings,
								secretEncrypted: null,
								nextScheduledAt:
									state === "enabled" ? yield* nextOccurrence(settings.schedule, to, now) : null,
							},
						);
					}),
				{ discard: true },
			);
		}).pipe(
			// Automations run only in the zones this runtime lists, a narrower set than Postgres knows.
			Effect.catchTag("InvalidRoutineSchedule", () => Effect.fail(new TimeZoneUnknown())),
		);

	return Service.of({
		get: (input) =>
			operation(
				"get",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(
						input.workspace,
						"workspace.update",
					);
					const [current] = yield* query((db) =>
						db
							.select({ timeZone: workspace.timeZone })
							.from(workspace)
							.where(eq(workspace.id, workspaceId)),
					);
					if (!current) return yield* new ResourceHidden({ resource: "workspace" });
					const [scheduled] = yield* query((db) =>
						db
							.select({ automations: countDistinct(automationTrigger.automationId) })
							.from(automationTrigger)
							.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
							.where(and(eq(automationTrigger.workspaceId, workspaceId), inZone(current.timeZone))),
					);
					return {
						timeZone: current.timeZone,
						automationsWithRoutines: scheduled?.automations ?? 0,
					};
				}),
			),

		change: (input) =>
			operation(
				"change",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(
						input.workspace,
						"workspace.update",
					);
					yield* requireTimeZoneKnownToPostgres(input.timeZone);
					yield* transaction(
						Effect.gen(function* () {
							// Locked, so a change made meanwhile moves the routines this one leaves.
							const [current] = yield* query((db) =>
								db
									.select({ timeZone: workspace.timeZone })
									.from(workspace)
									.where(eq(workspace.id, workspaceId))
									.for("update"),
							);
							if (!current) return yield* new ResourceHidden({ resource: "workspace" });
							if (current.timeZone === input.timeZone) return;
							yield* moveRoutines(workspaceId, current.timeZone, input.timeZone);
							yield* query((db) =>
								db
									.update(workspace)
									.set({ timeZone: input.timeZone })
									.where(eq(workspace.id, workspaceId)),
							);
						}),
					);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, AutomationStore.layer]));

/** Routines in `timeZone` of the automations still defined. */
function inZone(timeZone: string) {
	return and(
		eq(automationTrigger.kind, "routine"),
		sql`${automationTrigger.settings}->>'timezone' = ${timeZone}`,
		isNull(automation.deletedAt),
	);
}

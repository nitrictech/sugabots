export * as WorkspaceTimeZone from "./workspace-time-zone.ts";

import type { TimeZone, WorkspaceTimeZone as WorkspaceTimeZoneView } from "@sugabots/contracts";
import { and, countDistinct, eq, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { RoutineRepository } from "../../conversations/routines/repository.ts";
import { nextOccurrence } from "../../conversations/routines/schedule.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { routine, routineTrigger, workspace } from "../../database/schema.ts";
import {
	type InWorkspace,
	requireTimeZoneKnownToPostgres,
	TimeZoneUnknown,
} from "../membership/membership.ts";

/**
 * Where a workspace's days begin. Its routines' schedules in its zone are
 * taken to follow it, so they move when it does; a schedule set in any other
 * zone was chosen for that zone, and stays.
 */
export interface Interface {
	/** Takes the current actor's `workspace.update`, as changing it does. */
	readonly get: (
		input: InWorkspace,
	) => Effect.Effect<WorkspaceTimeZoneView, AuthorizationDenied, CurrentActor.Service>;
	/** Moves the workspace, and its routines' schedules in its old zone, to `timeZone`. */
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
	const routines = yield* RoutineRepository.Service;

	/** Rewrites each schedule in `from` to run in `to`, from now. */
	const moveSchedules = (workspaceId: string, from: string, to: TimeZone) =>
		Effect.gen(function* () {
			const schedules = yield* query((db) =>
				db
					.select({ trigger: routineTrigger, agentId: routine.agentId, state: routine.state })
					.from(routineTrigger)
					.innerJoin(routine, eq(routine.id, routineTrigger.routineId))
					.where(and(eq(routineTrigger.workspaceId, workspaceId), inZone(from)))
					.for("update", { of: routineTrigger }),
			);
			const now = yield* DateTime.nowAsDate;
			yield* Effect.forEach(
				schedules,
				({ trigger, agentId, state }) =>
					Effect.gen(function* () {
						if (trigger.settings.kind !== "cron") return;
						const settings = { ...trigger.settings, timezone: to };
						yield* routines.updateTrigger(
							{ workspaceId, agentId, routineId: trigger.routineId },
							trigger.id,
							{
								settings,
								secretEncrypted: null,
								secretDigest: null,
								nextScheduledAt:
									state === "enabled" ? yield* nextOccurrence(settings.schedule, to, now) : null,
							},
						);
					}),
				{ discard: true },
			);
		}).pipe(
			// Routines run only in the zones this runtime lists, a narrower set than Postgres knows.
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
							.select({ routines: countDistinct(routineTrigger.routineId) })
							.from(routineTrigger)
							.innerJoin(routine, eq(routine.id, routineTrigger.routineId))
							.where(and(eq(routineTrigger.workspaceId, workspaceId), inZone(current.timeZone))),
					);
					return { timeZone: current.timeZone, scheduledRoutines: scheduled?.routines ?? 0 };
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
							// Locked, so a change made meanwhile moves the schedules this one leaves.
							const [current] = yield* query((db) =>
								db
									.select({ timeZone: workspace.timeZone })
									.from(workspace)
									.where(eq(workspace.id, workspaceId))
									.for("update"),
							);
							if (!current) return yield* new ResourceHidden({ resource: "workspace" });
							if (current.timeZone === input.timeZone) return;
							yield* moveSchedules(workspaceId, current.timeZone, input.timeZone);
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

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, RoutineRepository.layer]),
);

/** Schedules in `timeZone` of the routines still defined. */
function inZone(timeZone: string) {
	return and(
		eq(routineTrigger.kind, "cron"),
		sql`${routineTrigger.settings}->>'timezone' = ${timeZone}`,
		isNull(routine.deletedAt),
	);
}

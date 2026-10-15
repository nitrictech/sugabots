import type { AcceptedRoutineExecution } from "@sugabots/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, connection, routine, routineTrigger } from "../../database/schema.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import type { Routines } from "./routines.ts";

/** Runs of connection routines, for what happened at their connections: `Routines.ConnectionEvents`. */
export const makeConnectionEvents = Effect.gen(function* () {
	const operation = yield* serviceOperations<Routines.ConnectionEventsInterface>(
		"Routines.ConnectionEvents",
	);
	const acceptTrigger = yield* makeAcceptTrigger;

	return {
		accept: ({ workspaceId, connectionId, deliveryId, activity }) =>
			operation(
				"accept",
				Effect.gen(function* () {
					const receivedAt = DateTime.formatIso(yield* DateTime.now);
					const routines = yield* listening({
						workspaceId,
						connectionId,
						repository: activity.repository,
						event: activity.event,
					});
					const accepted = yield* Effect.forEach(routines, (listener) =>
						acceptTrigger({
							workspaceId,
							agentId: listener.agentId,
							routineId: listener.routineId,
							triggerId: listener.triggerId,
							// A retry of the delivery lands on the run the first started.
							triggerIdentity: deliveryId,
							trigger: {
								kind: "github",
								connectionId,
								receivedAt,
								deliveryId,
								...activity,
							},
						}).pipe(
							Effect.map((execution): AcceptedRoutineExecution[] => [execution]),
							// Paused, removed or changed since it was found.
							Effect.catchTags({
								RoutineNotFound: () => Effect.succeed([]),
								RoutineTriggerRejected: () => Effect.succeed([]),
								RoutineTriggerConflict: () => Effect.succeed([]),
							}),
						),
					);
					return accepted.flat();
				}),
			),
	} satisfies Routines.ConnectionEventsInterface;
});

/**
 * The GitHub triggers of enabled routines run by `event` at `repository`,
 * through `connectionId`, while the connection still has the repository and
 * belongs to the routine's agent's pod.
 */
const listening = (on: {
	workspaceId: string;
	connectionId: string;
	repository: string;
	event: string;
}) =>
	query((db) =>
		db
			.select({
				routineId: routine.id,
				triggerId: routineTrigger.id,
				agentId: routine.agentId,
			})
			.from(routineTrigger)
			.innerJoin(routine, eq(routine.id, routineTrigger.routineId))
			.innerJoin(
				agent,
				and(eq(agent.id, routine.agentId), eq(agent.workspaceId, routine.workspaceId)),
			)
			.innerJoin(
				connection,
				and(
					eq(connection.id, on.connectionId),
					eq(connection.podId, agent.podId),
					eq(connection.workspaceId, agent.workspaceId),
					sql`${connection.id}::text = ${routineTrigger.settings}->>'connectionId'`,
					// GitHub's paths ignore case.
					sql`exists (select 1 from jsonb_array_elements(${connection.settings}->'repositories') as kept
						where lower(kept->>'path') = lower(${on.repository}))`,
				),
			)
			.where(
				and(
					eq(routine.workspaceId, on.workspaceId),
					eq(routineTrigger.kind, "github"),
					eq(routine.state, "enabled"),
					isNull(routine.deletedAt),
					sql`lower(${routineTrigger.settings}->>'repository') = lower(${on.repository})`,
					sql`${routineTrigger.settings}->'events' ? ${on.event}`,
				),
			),
	);

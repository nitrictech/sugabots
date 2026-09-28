export * as RoutineRunner from "./routine-runner.ts";

import type { AcceptedRoutineExecution } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { message } from "../../database/schema.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { TurnRequests } from "../turns/requests.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import { RoutineRepository } from "./repository.ts";
import type { RoutineNotFound, RoutineTriggerConflict, RoutineTriggerRejected } from "./routine.ts";
import type { RoutineRun } from "./routine.workflow.ts";
import { type InvalidRoutineSchedule, latestMissedAndNextOccurrence } from "./schedule.ts";

/**
 * The routine work nobody asks for: the scheduler accepting cron runs as they
 * fall due, and a run's workflow starting it. Neither acts for a person, so
 * this asks for no actor and is never handed to a route.
 */
export interface Interface {
	/** Accepts the run of the cron routine due soonest, if one is due, and schedules its next. */
	readonly processNextDue: () => Effect.Effect<
		AcceptedRoutineExecution | undefined,
		InvalidRoutineSchedule | RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected
	>;
	/** Marks a queued run started and asks for its turn. Does nothing once the run has ended. */
	readonly startRun: (run: RoutineRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/RoutineRunner",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineRunner");
	const repository = yield* RoutineRepository.Service;
	const requests = yield* TurnRequests.Service;
	const acceptTrigger = yield* makeAcceptTrigger;

	return Service.of({
		processNextDue: () =>
			operation(
				"processNextDue",
				transaction(
					Effect.gen(function* () {
						const now = yield* DateTime.nowAsDate;
						const due = yield* repository.lockNextDue(now);
						if (!due) return undefined;
						if (!due.cronExpression || !due.cronTimezone) {
							return yield* Effect.die(new Error("Cron Routine has incomplete schedule data"));
						}
						const occurrence = yield* latestMissedAndNextOccurrence(
							due.cronExpression,
							due.cronTimezone,
							now,
						);
						const scheduledAt = occurrence.latest.toISOString();
						const accepted = yield* acceptTrigger({
							workspaceId: due.workspaceId,
							agentId: due.agentId,
							routineId: due.id,
							triggerIdentity: scheduledAt,
							trigger: { kind: "cron", scheduledAt, acceptedAt: now.toISOString() },
						});
						yield* repository.scheduleNext(due.id, occurrence.next);
						return accepted;
					}),
				),
			),

		startRun: (run) =>
			operation(
				"startRun",
				transaction(
					Effect.gen(function* () {
						const execution = yield* repository.start(run.executionId);
						if (!execution) return;
						const [triggerMessage] = yield* query((db) =>
							db
								.select({ id: message.id })
								.from(message)
								.where(
									and(
										eq(message.threadId, execution.threadId),
										sql`${message.routineTrigger} is not null`,
									),
								)
								.limit(1),
						);
						if (!triggerMessage) {
							return yield* Effect.die(new Error("Routine trigger message is missing"));
						}
						// Asking again for a turn already asked for joins it, so a start
						// repeated after a crash does not run the turn twice.
						yield* requests.queueTurn({
							threadId: execution.threadId,
							agentId: execution.agentId,
							triggerMessageId: triggerMessage.id,
							reason: "routine",
						});
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([RoutineRepository.layer, ThreadRepository.layer]),
);

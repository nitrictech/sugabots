export * as AutomationRunner from "./automation-runner.ts";

import type { AcceptedRun } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { message } from "../../database/schema.ts";
import { ConversationRepository } from "../repository/repository.ts";
import { Turns } from "../turns/turns.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import type {
	AutomationNotFound,
	AutomationTriggerConflict,
	AutomationTriggerRejected,
} from "./automation.ts";
import type { AutomationRun } from "./automation.workflow.ts";
import { AutomationRepository } from "./repository.ts";
import { type InvalidRoutineSchedule, latestMissedAndNextOccurrence } from "./schedule.ts";

/**
 * The automation work nobody asks for: the scheduler accepting routines' runs as they
 * fall due, and a run's workflow starting it. Neither acts for a person, so
 * this asks for no actor and is never handed to a route.
 */
export interface Interface {
	/**
	 * Accepts the run of the routine due soonest, if one is due, and sets when
	 * it runs next. A routine of a project with no lead bot is skipped to its
	 * next time.
	 */
	readonly processNextDue: () => Effect.Effect<
		AcceptedRun | undefined,
		| InvalidRoutineSchedule
		| AutomationNotFound
		| AutomationTriggerConflict
		| AutomationTriggerRejected
	>;
	/** Marks a queued run started and asks for its turn. Does nothing once the run has ended. */
	readonly startRun: (run: AutomationRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AutomationRunner",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AutomationRunner");
	const repository = yield* AutomationRepository.Service;
	const turns = yield* Turns.Service;
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
						const { settings } = due.trigger;
						if (settings.kind !== "routine") {
							return yield* Effect.die(new Error("A trigger that isn't a routine fell due"));
						}
						const occurrence = yield* latestMissedAndNextOccurrence(
							settings.schedule,
							settings.timezone,
							now,
						);
						const scheduledAt = occurrence.latest.toISOString();
						const accepted = yield* acceptTrigger({
							workspaceId: due.automation.workspaceId,
							projectId: due.automation.projectId,
							automationId: due.automation.id,
							triggerId: due.trigger.id,
							triggerIdentity: scheduledAt,
							trigger: { kind: "routine", scheduledAt, acceptedAt: now.toISOString() },
						}).pipe(
							// Refused before anything is written, so the routine moves on to its next time.
							Effect.catchTag("AutomationProjectHasNoLead", () =>
								Effect.as(
									Effect.logWarning(
										`Skipped a routine of automation ${due.automation.id}: its project has no lead bot`,
									),
									undefined,
								),
							),
						);
						yield* repository.scheduleNext([{ triggerId: due.trigger.id, at: occurrence.next }]);
						return accepted;
					}),
				),
			),

		startRun: (run) =>
			operation(
				"startRun",
				transaction(
					Effect.gen(function* () {
						const execution = yield* repository.start(run.runId);
						if (!execution) return;
						const [triggerMessage] = yield* query((db) =>
							db
								.select({ id: message.id })
								.from(message)
								.where(
									and(
										eq(message.conversationId, execution.conversationId),
										sql`${message.automationTrigger} is not null`,
									),
								)
								.limit(1),
						);
						if (!triggerMessage) {
							return yield* Effect.die(new Error("Automation trigger message is missing"));
						}
						// Asking again for a turn already asked for joins it, so a start
						// repeated after a crash does not run the turn twice.
						yield* turns.ask({
							conversationId: execution.conversationId,
							botId: execution.botId,
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
	Layer.provide([AutomationRepository.layer, ConversationRepository.layer]),
);

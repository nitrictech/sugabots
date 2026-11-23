export * as AutomationRunner from "./automation-runner.ts";

import type { AcceptedRun } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { message } from "../../database/schema.ts";
import { ChatStore } from "../store/store.ts";
import { Turns } from "../turns/turns.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import type {
	AutomationNotFound,
	AutomationTriggerConflict,
	AutomationTriggerRejected,
} from "./automation.ts";
import type { AutomationRun } from "./automation.workflow.ts";
import { type InvalidRoutineSchedule, latestMissedAndNextOccurrence } from "./schedule.ts";
import { AutomationStore } from "./store.ts";

/**
 * The automation work nobody asks for: the scheduler accepting routines' runs as they
 * fall due, and a run's workflow starting it. Neither acts for a person, so
 * this asks for no actor and is never handed to a route.
 */
export interface Interface {
	/**
	 * Accepts the run of the routine due soonest, if one is due, and sets when
	 * it runs next.
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
	const store = yield* AutomationStore.Service;
	const turns = yield* Turns.Service;
	const acceptTrigger = yield* makeAcceptTrigger;

	return Service.of({
		processNextDue: () =>
			operation(
				"processNextDue",
				transaction(
					Effect.gen(function* () {
						const now = yield* DateTime.nowAsDate;
						const due = yield* store.lockNextDue(now);
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
						});
						yield* store.scheduleNext([{ triggerId: due.trigger.id, at: occurrence.next }]);
						return accepted;
					}),
				),
			),

		startRun: (run) =>
			operation(
				"startRun",
				transaction(
					Effect.gen(function* () {
						const execution = yield* store.start(run.runId);
						if (!execution) return;
						const [triggerMessage] = yield* query((db) =>
							db
								.select({ id: message.id })
								.from(message)
								.where(
									and(
										eq(message.chatId, execution.chatId),
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
							chatId: execution.chatId,
							botId: execution.botId,
							triggerMessageId: triggerMessage.id,
							reason: "automation",
						});
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([AutomationStore.layer, ChatStore.layer]));

export * as AutomationRunner from "./automation-runner.ts";

import { isDeepStrictEqual } from "node:util";
import type { AcceptedRun } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Cause, Context, DateTime, Effect, Layer, Result } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { isRetryableTransactionError } from "../../database/errors.ts";
import { message } from "../../database/schema.ts";
import type { DoesStoredWork } from "../../proofs/does-stored-work.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ChatStore } from "../store/store.ts";
import { Turns } from "../turns/turns.ts";
import { makeAcceptTrigger } from "./acceptance.ts";
import { lockTriggers } from "./automation.ts";
import type { AutomationRun } from "./automation.workflow.ts";
import { latestMissedAndNextOccurrence } from "./schedule.ts";
import { AutomationStore } from "./store.ts";

export interface Interface {
	readonly runDueRoutine: <P, I>(
		work: DoesStoredWork<P, I, "dueRoutine">,
	) => Effect.Effect<AcceptedRun | "skipped" | "retry" | undefined>;
	/** Marks a queued run started and asks for its turn. Does nothing once the run has ended. */
	readonly startRun: (run: AutomationRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AutomationRunner",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AutomationRunner");
	const store = yield* AutomationStore.Service;
	const turns = yield* Turns.Service;
	const acceptTrigger = yield* makeAcceptTrigger;
	const consecutiveDefects = new Map<string, { dueAt: number | undefined; count: number }>();

	const runDueRoutine: Interface["runDueRoutine"] = (proof) => {
		const scope = {
			workspaceId: proof.workspace,
			projectId: proof.work.project,
			automationId: proof.work.automation,
		};
		const triggerId = proof.id.value;
		return operation(
			"runDueRoutine",
			transaction(
				Effect.gen(function* () {
					yield* lockTriggers(scope.automationId);
					const now = yield* DateTime.nowAsDate;
					const due = yield* store.lockDueRoutine(now, scope, triggerId);
					if (due?.settings.kind !== "routine") return undefined;
					const occurrence = yield* Effect.result(
						latestMissedAndNextOccurrence(due.settings.schedule, due.settings.timezone, now),
					);
					if (Result.isFailure(occurrence)) {
						yield* store.scheduleNext([{ triggerId, at: null }]);
						yield* Effect.logError(
							"Cleared a routine's next time because its timetable is invalid",
							{ triggerId, error: occurrence.failure },
						);
						return "skipped" as const;
					}
					const { latest, next } = occurrence.success;
					const scheduledAt = latest.toISOString();
					const accepted = yield* acceptTrigger({
						...scope,
						triggerId,
						triggerIdentity: scheduledAt,
						trigger: { kind: "routine", scheduledAt, acceptedAt: now.toISOString() },
					}).pipe(
						Effect.catchCause((cause) => {
							if (Cause.hasInterrupts(cause)) return Effect.interrupt;
							if (Cause.hasDies(cause)) return Effect.fail({ cause, due, next, scheduledAt });
							return Effect.logError("Could not accept a routine occurrence", {
								triggerId,
								scheduledAt,
								cause,
							}).pipe(Effect.as("skipped" as const));
						}),
					);
					yield* store.scheduleNext([{ triggerId, at: next }]);
					return accepted;
				}),
			).pipe(
				Effect.tap(() => Effect.sync(() => void consecutiveDefects.delete(triggerId))),
				Effect.catch(({ cause, due, next, scheduledAt }) =>
					Effect.gen(function* () {
						if (isRetryableTransactionError(cause)) {
							yield* Effect.logWarning("Routine acceptance will retry after a database error", {
								triggerId,
								scheduledAt,
								cause,
							});
							return "retry" as const;
						}
						const dueAt = due.nextScheduledAt?.getTime();
						const previous = consecutiveDefects.get(triggerId);
						const count = previous && previous.dueAt === dueAt ? previous.count + 1 : 1;
						if (!previous && consecutiveDefects.size >= MAX_TRACKED_ROUTINES) {
							const oldest = consecutiveDefects.keys().next().value;
							if (oldest !== undefined) consecutiveDefects.delete(oldest);
						}
						consecutiveDefects.set(triggerId, { dueAt, count });
						const retry = count < MAX_CONSECUTIVE_DEFECTS;
						yield* Effect.logError(
							retry
								? "Routine acceptance will retry"
								: "Skipping a routine after repeated acceptance defects",
							{
								triggerId,
								scheduledAt,
								cause,
								consecutiveDefects: count,
							},
						);
						if (retry) return "retry" as const;
						yield* transaction(
							Effect.gen(function* () {
								yield* lockTriggers(scope.automationId);
								const current = yield* store.lockDueRoutine(
									yield* DateTime.nowAsDate,
									scope,
									triggerId,
								);
								// A member or another scheduler may have changed the routine after rollback.
								if (isDeepStrictEqual(current, due)) {
									yield* store.scheduleNext([{ triggerId, at: next }]);
								}
							}),
						);
						consecutiveDefects.delete(triggerId);
						return "skipped" as const;
					}),
				),
				Effect.catchCause((cause) =>
					!Cause.hasInterrupts(cause) && isRetryableTransactionError(cause)
						? Effect.logWarning("Routine acceptance will retry after a database error", {
								triggerId,
								cause,
							}).pipe(Effect.as("retry" as const))
						: Effect.failCause(cause),
				),
			),
		);
	};

	return Service.of({
		runDueRoutine,

		startRun: (run) =>
			operation(
				"startRun",
				transaction(
					Effect.gen(function* () {
						const started = yield* store.start(run.runId);
						if (!started) return;
						const [triggerMessage] = yield* query((db) =>
							db
								.select({ id: message.id })
								.from(message)
								.where(
									and(
										eq(message.chatId, started.chatId),
										sql`${message.automationTrigger} is not null`,
									),
								)
								.limit(1),
						);
						if (!triggerMessage) {
							return yield* Effect.die(new Error("Automation trigger message is missing"));
						}
						// Asking again for a turn already asked for starts no second one: it
						// is the same workflow execution, so a start repeated after a crash
						// does not run the turn twice.
						yield* turns.ask({
							chatId: started.chatId,
							botId: started.botId,
							triggerMessageId: triggerMessage.id,
							reason: "automation",
						});
					}),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([AutomationStore.layer, ChatStore.layer]));

const MAX_CONSECUTIVE_DEFECTS = 3;
const MAX_TRACKED_ROUTINES = 256;

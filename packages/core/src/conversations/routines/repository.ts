export * as RoutineRepository from "./repository.ts";

import { type UserText, userText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import {
	query,
	queryCatching,
	serviceOperations,
	transaction,
	writtenRow,
} from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { routine, routineExecution, routineTrigger, thread } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import type { Turns } from "../turns/turns.ts";
import { inScope, type Scope } from "./routine.ts";
import { RoutineRuns } from "./runs.ts";

/**
 * The only writer of `routine`, `routine_trigger` and `routine_execution`:
 * what a crew agent does, what starts it, and each run of it.
 *
 * A removed routine keeps its row, so its runs keep their history, and is
 * invisible to every command. A run is `queued` until its workflow starts
 * it, `running` until settlement records how it ended, and may be ending
 * meanwhile (`pending_terminal_state`) once something started ending it.
 * Accepting a run and ending one are announced.
 */
export interface Interface {
	readonly create: (
		definition: Definition &
			Pick<schema.RoutineRow, "workspaceId" | "agentId" | "createdById" | "createdByAgentId">,
	) => Effect.Effect<schema.RoutineRow, RoutineNameTaken>;
	/**
	 * Changes a routine's definition, and clears that it paused itself when
	 * `pausedAfterFailuresAt` is null. `undefined` when there is no such routine.
	 */
	readonly update: (
		scope: Scope,
		definition: Definition & { pausedAfterFailuresAt?: null },
	) => Effect.Effect<schema.RoutineRow | undefined, RoutineNameTaken>;
	/**
	 * Removes a routine, pausing it and cancelling the runs still queued, and
	 * announces each of those runs ended. `false` when there is no such
	 * routine.
	 */
	readonly remove: (scope: Scope) => Effect.Effect<boolean>;
	/** Adds `triggers` to the routine `scope` names, in order. */
	readonly addTriggers: (
		scope: Scope,
		triggers: readonly TriggerValues[],
	) => Effect.Effect<schema.RoutineTriggerRow[]>;
	/** Rewrites one of the routine's triggers. `undefined` when it has no such trigger. */
	readonly updateTrigger: (
		scope: Scope,
		triggerId: string,
		values: TriggerValues,
	) => Effect.Effect<schema.RoutineTriggerRow | undefined>;
	/** `false` when the routine has no such trigger. */
	readonly removeTrigger: (scope: Scope, triggerId: string) => Effect.Effect<boolean>;
	/**
	 * Replaces a webhook trigger's secret with `sealed`, a secret sealed with
	 * `Credentials`, or null for none. `false` when there is no such webhook
	 * trigger on the routine.
	 */
	readonly replaceWebhookSecret: (
		scope: Scope,
		triggerId: string,
		sealed: string | null,
	) => Effect.Effect<boolean>;
	/**
	 * The schedule due soonest at `now`, of an enabled routine, with its
	 * routine, locked until the transaction ends. One another transaction
	 * holds is skipped.
	 */
	readonly lockNextDue: (
		now: Date,
	) => Effect.Effect<{ trigger: schema.RoutineTriggerRow; routine: schema.RoutineRow } | undefined>;
	/** Sets when each schedule next runs its routine; null while the routine is paused. */
	readonly scheduleNext: (
		next: ReadonlyArray<{ triggerId: string; at: Date | null }>,
	) => Effect.Effect<void>;
	/** Records a queued run whose thread is open in the agent's chat, and announces it. */
	readonly accept: (
		run: Pick<
			schema.RoutineExecutionRow,
			| "routineId"
			| "workspaceId"
			| "agentId"
			| "threadId"
			| "triggerId"
			| "triggerKind"
			| "triggerIdentity"
			| "trigger"
			| "routineName"
			| "instructions"
			| "results"
			| "acceptedAt"
		>,
	) => Effect.Effect<schema.RoutineExecutionRow>;
	/**
	 * Marks a queued run running. Returns the run while it is queued or
	 * running, and `undefined` once it has ended.
	 */
	readonly start: (executionId: string) => Effect.Effect<schema.RoutineExecutionRow | undefined>;
	/**
	 * Adds `ending` to how a running run is ending (see `endingAfter`), locking
	 * the run until the transaction ends. `true` when this started the ending.
	 *
	 * Lock order: settlement writes the run only after it has cancelled the
	 * run's work, so a transaction that ends a turn and then records the run's
	 * ending never waits on a turn that settlement holds.
	 */
	readonly recordEnding: (executionId: string, ending: Turns.Ended) => Effect.Effect<boolean>;
	/**
	 * Records how a running run ended, and announces it. `false` when the run
	 * was not running. A failure pauses its routine when it is the
	 * `FAILURES_THAT_PAUSE`th in a row.
	 */
	readonly settle: (executionId: string, settled: Settled) => Effect.Effect<boolean>;
	/**
	 * Records a run that has not ended as failed, telling people
	 * `userMessage`, and announces it, pausing its routine as `settle` does.
	 * Does nothing once the run has ended.
	 */
	readonly fail: (executionId: string, userMessage: UserText) => Effect.Effect<void>;
	/**
	 * Turns on again the routine `routineId` when it paused itself after
	 * failing. `true` when it did, so its schedules are due to be set again.
	 */
	readonly resumeAfterFailures: (routineId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/RoutineRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineRepository");
	const { emit } = yield* ConversationEvents.Service;
	const runs = yield* RoutineRuns.Service;

	/** The routine's own thread, which lists the run, and its pod. */
	const listingOf = (run: schema.RoutineExecutionRow) =>
		Effect.gen(function* () {
			const [root] = yield* query((db) =>
				db
					.select({ conversationId: thread.conversationId, podId: thread.podId })
					.from(thread)
					.where(eq(thread.id, run.threadId))
					.limit(1),
			);
			if (!root?.conversationId) {
				return yield* Effect.die(new Error("Routine thread is in no conversation"));
			}
			return { conversationId: root.conversationId, podId: root.podId };
		});

	/**
	 * Pauses the routine `routineId` when its last `FAILURES_THAT_PAUSE`
	 * finished runs all failed and it is still on, recording that it paused
	 * itself, and clears when its schedules next run.
	 */
	const pauseAfterFailures = (routineId: string) =>
		Effect.gen(function* () {
			const paused = yield* query((db) =>
				db
					.update(routine)
					.set({ state: "paused", pausedAfterFailuresAt: sql`now()` })
					.where(
						and(
							eq(routine.id, routineId),
							eq(routine.state, "enabled"),
							isNull(routine.deletedAt),
							sql`(
							select count(*) from (
								select ${routineExecution.state} as state from ${routineExecution}
								where ${routineExecution.routineId} = ${routineId}
									and ${routineExecution.finishedAt} is not null
								order by ${routineExecution.acceptedAt} desc, ${routineExecution.id} desc
								limit ${FAILURES_THAT_PAUSE}
							) as latest
							where latest.state = 'failed'
						) = ${FAILURES_THAT_PAUSE}`,
						),
					)
					.returning({ id: routine.id }),
			);
			if (paused.length === 0) return;
			// A paused routine's schedules have no next time.
			yield* query((db) =>
				db
					.update(routineTrigger)
					.set({ nextScheduledAt: null })
					.where(eq(routineTrigger.routineId, routineId)),
			);
		});

	/** Tells the workspace that a run's thread changed because the run ended. */
	const announceEnded = (run: schema.RoutineExecutionRow) =>
		Effect.gen(function* () {
			yield* emit([
				ConversationEvent.RoutineExecutionSettled({
					workspaceId: run.workspaceId,
					...(yield* listingOf(run)),
					threadId: run.threadId,
				}),
			]);
		});

	return Service.of({
		resumeAfterFailures: (routineId) =>
			operation(
				"resumeAfterFailures",
				Effect.map(
					query((db) =>
						db
							.update(routine)
							.set({ state: "enabled", pausedAfterFailuresAt: null })
							.where(
								and(
									eq(routine.id, routineId),
									sql`${routine.pausedAfterFailuresAt} is not null`,
									isNull(routine.deletedAt),
								),
							)
							.returning({ id: routine.id }),
					),
					(resumed) => resumed.length > 0,
				),
			),

		create: (definition) =>
			operation(
				"create",
				queryCatching(
					(db) => db.insert(routine).values(definition).returning(),
					(rejection) => (isUniqueViolation(rejection) ? new RoutineNameTaken() : undefined),
				).pipe(Effect.flatMap(writtenRow("routine"))),
			),

		update: (scope, definition) =>
			operation(
				"update",
				Effect.map(
					queryCatching(
						(db) => db.update(routine).set(definition).where(inScope(scope)).returning(),
						(rejection) => (isUniqueViolation(rejection) ? new RoutineNameTaken() : undefined),
					),
					([row]) => row,
				),
			),

		remove: (scope) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						const now = yield* DateTime.nowAsDate;
						const [removed] = yield* query((db) =>
							db
								.update(routine)
								.set({ deletedAt: now, state: "paused" })
								.where(inScope(scope))
								.returning({ id: routine.id }),
						);
						if (!removed) return false;
						yield* query((db) =>
							db
								.update(routineTrigger)
								.set({ nextScheduledAt: null })
								.where(eq(routineTrigger.routineId, removed.id)),
						);
						const cancelled = yield* query((db) =>
							db
								.update(routineExecution)
								.set({ state: "cancelled", finishedAt: now })
								.where(
									and(
										eq(routineExecution.routineId, removed.id),
										eq(routineExecution.state, "queued"),
									),
								)
								.returning(),
						);
						for (const run of cancelled) {
							yield* announceEnded(run);
							yield* runs.settled({ routineId: run.routineId, executionId: run.id });
						}
						return true;
					}),
				),
			),

		addTriggers: (scope, triggers) =>
			operation(
				"addTriggers",
				triggers.length === 0
					? Effect.succeed([])
					: query((db) =>
							db
								.insert(routineTrigger)
								.values(
									triggers.map((values) => ({
										...values,
										workspaceId: scope.workspaceId,
										routineId: scope.routineId,
									})),
								)
								.returning(),
						),
			),

		updateTrigger: (scope, triggerId, values) =>
			operation(
				"updateTrigger",
				Effect.map(
					query((db) =>
						db.update(routineTrigger).set(values).where(ofRoutine(scope, triggerId)).returning(),
					),
					([row]) => row,
				),
			),

		removeTrigger: (scope, triggerId) =>
			operation(
				"removeTrigger",
				Effect.map(
					query((db) =>
						db
							.delete(routineTrigger)
							.where(ofRoutine(scope, triggerId))
							.returning({ id: routineTrigger.id }),
					),
					(rows) => rows.length > 0,
				),
			),

		replaceWebhookSecret: (scope, triggerId, sealed) =>
			operation(
				"replaceWebhookSecret",
				Effect.map(
					query((db) =>
						db
							.update(routineTrigger)
							.set({ secretEncrypted: sealed, secretDigest: null })
							.where(and(ofRoutine(scope, triggerId), eq(routineTrigger.kind, "webhook")))
							.returning({ id: routineTrigger.id }),
					),
					(rows) => rows.length > 0,
				),
			),

		lockNextDue: (now) =>
			operation(
				"lockNextDue",
				Effect.map(
					query((db) =>
						db
							.select({ trigger: routineTrigger, routine })
							.from(routineTrigger)
							.innerJoin(routine, eq(routine.id, routineTrigger.routineId))
							.where(
								and(
									eq(routine.state, "enabled"),
									isNull(routine.deletedAt),
									sql`${routineTrigger.nextScheduledAt} <= ${now}`,
								),
							)
							.orderBy(asc(routineTrigger.nextScheduledAt), asc(routineTrigger.id))
							.limit(1)
							.for("update", { of: routineTrigger, skipLocked: true }),
					),
					([due]) => due,
				),
			),

		scheduleNext: (next) =>
			operation(
				"scheduleNext",
				Effect.forEach(
					next,
					({ triggerId, at }) =>
						query((db) =>
							db
								.update(routineTrigger)
								.set({ nextScheduledAt: at })
								.where(eq(routineTrigger.id, triggerId)),
						),
					{ discard: true },
				),
			),

		accept: (run) =>
			operation(
				"accept",
				transaction(
					Effect.gen(function* () {
						const accepted = yield* query((db) =>
							db.insert(routineExecution).values(run).returning(),
						).pipe(Effect.flatMap(writtenRow("routine_execution")));
						yield* emit([
							ConversationEvent.RoutineExecutionAccepted({
								workspaceId: accepted.workspaceId,
								...(yield* listingOf(accepted)),
								threadId: accepted.threadId,
							}),
						]);
						return accepted;
					}),
				),
			),

		start: (executionId) =>
			operation(
				"start",
				transaction(
					Effect.gen(function* () {
						const [execution] = yield* query((db) =>
							db
								.select()
								.from(routineExecution)
								.where(eq(routineExecution.id, executionId))
								.limit(1)
								.for("update"),
						);
						if (execution?.state === "running") return execution;
						if (execution?.state !== "queued") return undefined;
						const startedAt = yield* DateTime.nowAsDate;
						return yield* query((db) =>
							db
								.update(routineExecution)
								.set({ state: "running", startedAt })
								.where(eq(routineExecution.id, executionId))
								.returning(),
						).pipe(Effect.flatMap(writtenRow("routine_execution")));
					}),
				),
			),

		recordEnding: (executionId, ending) =>
			operation(
				"recordEnding",
				Effect.gen(function* () {
					const running = and(
						eq(routineExecution.id, executionId),
						eq(routineExecution.state, "running"),
					);
					const [run] = yield* query((db) =>
						db.select().from(routineExecution).where(running).limit(1).for("update"),
					);
					if (!run) return false;
					const was = endingOf(run);
					const merged = endingAfter(was, ending);
					if (merged === was) return false;
					yield* query((db) =>
						db
							.update(routineExecution)
							.set({
								pendingTerminalState: merged?.state ?? null,
								pendingTerminalError: merged?.state === "failed" ? merged.error : null,
							})
							.where(running),
					);
					return was === undefined;
				}),
			),

		settle: (executionId, settled) =>
			operation(
				"settle",
				transaction(
					Effect.gen(function* () {
						const finishedAt = yield* DateTime.nowAsDate;
						const [recorded] = yield* query((db) =>
							db
								.update(routineExecution)
								.set({
									state: settled.state,
									error: settled.state === "failed" ? settled.error : null,
									finishedAt,
									pendingTerminalState: null,
									pendingTerminalError: null,
								})
								.where(
									and(eq(routineExecution.id, executionId), eq(routineExecution.state, "running")),
								)
								.returning(),
						);
						if (!recorded) return false;
						yield* announceEnded(recorded);
						if (recorded.state === "failed") yield* pauseAfterFailures(recorded.routineId);
						return true;
					}),
				),
			),

		fail: (executionId, userMessage) =>
			operation(
				"fail",
				transaction(
					Effect.gen(function* () {
						const finishedAt = yield* DateTime.nowAsDate;
						const [failed] = yield* query((db) =>
							db
								.update(routineExecution)
								.set({
									state: "failed",
									error: userMessage,
									finishedAt,
									pendingTerminalState: null,
									pendingTerminalError: null,
								})
								.where(
									and(
										eq(routineExecution.id, executionId),
										inArray(routineExecution.state, ["queued", "running"]),
									),
								)
								.returning(),
						);
						if (!failed) return;
						yield* announceEnded(failed);
						yield* pauseAfterFailures(failed.routineId);
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** What a routine is: its name, what it tells the agent, where its result goes, and whether it runs. */
export type Definition = Pick<
	schema.RoutineRow,
	"name" | "instructions" | "results" | "chatId" | "state"
>;

/** What one of a routine's triggers is, and what it keeps beside that: a webhook's secret, a schedule's next time. */
export type TriggerValues = Pick<
	schema.RoutineTriggerRow,
	"settings" | "secretEncrypted" | "secretDigest" | "nextScheduledAt"
>;

/** The trigger `triggerId`, when it is one of the routine `scope` names, which hasn't been removed. */
const ofRoutine = (scope: Scope, triggerId: string) =>
	and(
		eq(routineTrigger.id, triggerId),
		eq(routineTrigger.routineId, scope.routineId),
		eq(routineTrigger.workspaceId, scope.workspaceId),
		sql`exists (select 1 from ${routine} where ${inScope(scope)})`,
	);

/** Failed runs in a row after which a routine pauses itself. */
export const FAILURES_THAT_PAUSE = 2;

/** How a run's work ended. */
export type Settled = Turns.Ended | { readonly state: "completed" };

export class RoutineNameTaken extends Data.TaggedError("RoutineNameTaken") implements UserFacing {
	get userMessage() {
		return userText`A Routine with that name already exists`;
	}
}

/**
 * endingAfter returns how a run ends once `outcome` is added to `ending`, how
 * it was already ending. A failure stands over a cancellation.
 */
export function endingAfter(
	ending: Turns.Ended | undefined,
	outcome: Turns.Ended | undefined,
): Turns.Ended | undefined {
	if (!outcome || ending?.state === "failed") return ending;
	if (outcome.state === "cancelled" && ending?.state === "cancelled") return ending;
	return outcome;
}

/** How the run is already ending, if something has started ending it. */
export function endingOf(run: schema.RoutineExecutionRow): Turns.Ended | undefined {
	if (run.pendingTerminalState === "cancelled") return { state: "cancelled" };
	if (run.pendingTerminalState === "failed") {
		// `pending_terminal_error` is nullable in the schema; a failure recorded
		// without one reads as having stopped unexpectedly.
		return { state: "failed", error: run.pendingTerminalError ?? RUN_STOPPED_UNEXPECTEDLY };
	}
	return undefined;
}

/** What people are told about a run whose workflow failed; the cause goes only to the logs. */
export const RUN_STOPPED_UNEXPECTEDLY = userText`The routine run stopped unexpectedly`;

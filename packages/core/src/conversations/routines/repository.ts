export * as RoutineRepository from "./repository.ts";

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
import { routine, routineExecution, thread } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import type { Ended } from "../turns/lifecycle.ts";

/**
 * The only writer of `routine` and `routine_execution`: what a crew agent
 * does on a schedule or a webhook, and each run of it.
 *
 * A removed routine keeps its row, so its runs keep their history, and is
 * invisible to every command. A run is `queued` until its workflow starts
 * it, `running` until settlement records how it ended, and may be ending
 * meanwhile (`pending_terminal_state`) once something started ending it.
 * Accepting a run and ending one are announced.
 */
export interface Interface {
	readonly create: (
		definition: Definition & Pick<schema.RoutineRow, "workspaceId" | "agentId" | "createdById">,
	) => Effect.Effect<schema.RoutineRow, RoutineNameTaken>;
	/** Changes a routine's definition. `undefined` when there is no such routine. */
	readonly update: (
		scope: Scope,
		definition: Definition,
	) => Effect.Effect<schema.RoutineRow | undefined, RoutineNameTaken>;
	/**
	 * Removes a routine, pausing it and cancelling the runs still queued.
	 * `false` when there is no such routine.
	 */
	readonly remove: (scope: Scope) => Effect.Effect<boolean>;
	/** Replaces a webhook routine's secret. `false` when there is no such webhook routine. */
	readonly replaceWebhookSecret: (scope: Scope, digest: string) => Effect.Effect<boolean>;
	/**
	 * The enabled cron routine due soonest at `now`, locked until the
	 * transaction ends. One another transaction holds is skipped.
	 */
	readonly lockNextDue: (now: Date) => Effect.Effect<schema.RoutineRow | undefined>;
	readonly scheduleNext: (routineId: string, next: Date) => Effect.Effect<void>;
	/** Records a queued run whose thread is open in the agent's chat `chatId`, and announces it. */
	readonly accept: (
		run: Pick<
			schema.RoutineExecutionRow,
			| "routineId"
			| "workspaceId"
			| "agentId"
			| "threadId"
			| "triggerKind"
			| "triggerIdentity"
			| "trigger"
			| "routineName"
			| "instructions"
			| "acceptedAt"
		> & { chatId: string },
	) => Effect.Effect<schema.RoutineExecutionRow>;
	/**
	 * Marks a queued run running. Returns the run while it is queued or
	 * running, and `undefined` once it has ended.
	 */
	readonly start: (executionId: string) => Effect.Effect<schema.RoutineExecutionRow | undefined>;
	/** Records how a running run is ending, or that nothing is ending it. */
	readonly recordEnding: (executionId: string, ending: Ended | undefined) => Effect.Effect<void>;
	/**
	 * Records how a running run ended, and announces it. `false` when the run
	 * was not running.
	 */
	readonly settle: (executionId: string, settled: Settled) => Effect.Effect<boolean>;
	/**
	 * Records a run that has not ended as failed, telling people
	 * `userMessage`, and announces it. Does nothing once the run has ended.
	 */
	readonly fail: (executionId: string, userMessage: UserMessage) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/RoutineRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineRepository");
	const { emit } = yield* ConversationEvents.Service;

	/** Tells the workspace that a run's thread changed because the run ended. */
	const announceEnded = (run: schema.RoutineExecutionRow) =>
		Effect.gen(function* () {
			const [root] = yield* query((db) =>
				db
					.select({ chatId: thread.chatId })
					.from(thread)
					.where(eq(thread.id, run.threadId))
					.limit(1),
			);
			if (!root?.chatId) return yield* Effect.die(new Error("Routine thread has no Chat"));
			yield* emit([
				ConversationEvent.RoutineExecutionSettled({
					workspaceId: run.workspaceId,
					chatId: root.chatId,
					threadId: run.threadId,
				}),
			]);
		});

	return Service.of({
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
								.set({ deletedAt: now, state: "paused", nextScheduledAt: null })
								.where(inScope(scope))
								.returning({ id: routine.id }),
						);
						if (!removed) return false;
						yield* query((db) =>
							db
								.update(routineExecution)
								.set({ state: "cancelled", finishedAt: now })
								.where(
									and(
										eq(routineExecution.routineId, removed.id),
										eq(routineExecution.state, "queued"),
									),
								),
						);
						return true;
					}),
				),
			),

		replaceWebhookSecret: (scope, digest) =>
			operation(
				"replaceWebhookSecret",
				Effect.map(
					query((db) =>
						db
							.update(routine)
							.set({ webhookSecretDigest: digest })
							.where(and(inScope(scope), eq(routine.triggerKind, "webhook")))
							.returning({ id: routine.id }),
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
							.select()
							.from(routine)
							.where(
								and(
									eq(routine.triggerKind, "cron"),
									eq(routine.state, "enabled"),
									isNull(routine.deletedAt),
									sql`${routine.nextScheduledAt} <= ${now}`,
								),
							)
							.orderBy(asc(routine.nextScheduledAt), asc(routine.id))
							.limit(1)
							.for("update", { skipLocked: true }),
					),
					([due]) => due,
				),
			),

		scheduleNext: (routineId, next) =>
			operation(
				"scheduleNext",
				query((db) =>
					db.update(routine).set({ nextScheduledAt: next }).where(eq(routine.id, routineId)),
				).pipe(Effect.asVoid),
			),

		accept: ({ chatId, ...run }) =>
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
								chatId,
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
				query((db) =>
					db
						.update(routineExecution)
						.set({
							pendingTerminalState: ending?.state ?? null,
							pendingTerminalError: ending?.state === "failed" ? ending.error : null,
						})
						.where(
							and(eq(routineExecution.id, executionId), eq(routineExecution.state, "running")),
						),
				).pipe(Effect.asVoid),
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
									...settled,
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
						if (failed) yield* announceEnded(failed);
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** A routine on an agent in a workspace. */
export interface Scope {
	readonly workspaceId: string;
	readonly agentId: string;
	readonly routineId: string;
}

/** What a routine is: its name, what it tells the agent, and what starts it. */
export type Definition = Pick<
	schema.RoutineRow,
	| "name"
	| "instructions"
	| "triggerKind"
	| "cronExpression"
	| "cronTimezone"
	| "nextScheduledAt"
	| "webhookSecretDigest"
	| "state"
>;

/** How a run's work ended. */
export type Settled = { state: "completed" | "failed" | "cancelled"; error: UserMessage | null };

export class RoutineNameTaken extends Data.TaggedError("RoutineNameTaken") implements UserFacing {
	get userMessage() {
		return UserMessage.of`A Routine with that name already exists`;
	}
}

/** The routine `scope` names, unless it has been removed. */
export const inScope = (scope: Scope) =>
	and(
		eq(routine.id, scope.routineId),
		eq(routine.workspaceId, scope.workspaceId),
		eq(routine.agentId, scope.agentId),
		isNull(routine.deletedAt),
	);

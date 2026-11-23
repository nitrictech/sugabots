export * as AutomationRepository from "./repository.ts";

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
import {
	automation,
	automationFeed,
	automationRun,
	automationTrigger,
} from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import type { Turns } from "../turns/turns.ts";
import { inScope, type Scope } from "./automation.ts";
import { AutomationRuns } from "./runs.ts";

/**
 * The only writer of `automation`, `automation_trigger` and `run`:
 * what a project's lead bot does on its own, what starts it, and each run of it.
 *
 * A removed automation keeps its row, so its runs keep their history, and is
 * invisible to every command. A run is `queued` until its workflow starts
 * it, `running` until settlement records how it ended, and may be ending
 * meanwhile (`pending_terminal_state`) once something started ending it.
 * Accepting a run and ending one are announced.
 */
export interface Interface {
	readonly create: (
		definition: Definition &
			Pick<schema.AutomationRow, "workspaceId" | "projectId" | "createdById" | "createdByBotId">,
	) => Effect.Effect<schema.AutomationRow, AutomationNameTaken>;
	/**
	 * Changes an automation's definition, and clears that it paused itself when
	 * `pausedAfterFailuresAt` is null. `undefined` when there is no such automation.
	 */
	readonly update: (
		scope: Scope,
		definition: Definition & { pausedAfterFailuresAt?: null },
	) => Effect.Effect<schema.AutomationRow | undefined, AutomationNameTaken>;
	/**
	 * Removes an automation, pausing it and cancelling the runs still queued, and
	 * announces each of those runs ended. `false` when there is no such
	 * automation.
	 */
	readonly remove: (scope: Scope) => Effect.Effect<boolean>;
	/** Adds `triggers` to the automation `scope` names, in order. */
	readonly addTriggers: (
		scope: Scope,
		triggers: readonly TriggerValues[],
	) => Effect.Effect<schema.AutomationTriggerRow[]>;
	/** Rewrites one of the automation's triggers. `undefined` when it has no such trigger. */
	readonly updateTrigger: (
		scope: Scope,
		triggerId: string,
		values: TriggerValues,
	) => Effect.Effect<schema.AutomationTriggerRow | undefined>;
	/** `false` when the automation has no such trigger. */
	readonly removeTrigger: (scope: Scope, triggerId: string) => Effect.Effect<boolean>;
	/**
	 * Replaces a webhook trigger's secret with `sealed`, a secret sealed with
	 * `Credentials`, or null for none. `false` when there is no such webhook
	 * trigger on the automation.
	 */
	readonly replaceWebhookSecret: (
		scope: Scope,
		triggerId: string,
		sealed: string | null,
	) => Effect.Effect<boolean>;
	/**
	 * The routine due soonest at `now`, of an enabled automation, with its
	 * automation, locked until the transaction ends. One another transaction
	 * holds is skipped.
	 */
	readonly lockNextDue: (
		now: Date,
	) => Effect.Effect<
		{ trigger: schema.AutomationTriggerRow; automation: schema.AutomationRow } | undefined
	>;
	/** Sets when each routine next runs its automation; null while the automation is paused. */
	readonly scheduleNext: (
		next: ReadonlyArray<{ triggerId: string; at: Date | null }>,
	) => Effect.Effect<void>;
	/** Records a queued run whose conversation was opened in the same transaction, and announces it. */
	readonly accept: (
		run: Pick<
			schema.RunRow,
			| "automationId"
			| "workspaceId"
			| "botId"
			| "conversationId"
			| "triggerId"
			| "triggerKind"
			| "triggerIdentity"
			| "trigger"
			| "automationName"
			| "instructions"
			| "acceptedAt"
		>,
	) => Effect.Effect<schema.RunRow>;
	/**
	 * Marks a queued run running. Returns the run while it is queued or
	 * running, and `undefined` once it has ended.
	 */
	readonly start: (runId: string) => Effect.Effect<schema.RunRow | undefined>;
	/**
	 * Adds `ending` to how a running run is ending (see `endingAfter`), locking
	 * the run until the transaction ends. `true` when this started the ending.
	 *
	 * Lock order: settlement writes the run only after it has cancelled the
	 * run's work, so a transaction that ends a turn and then records the run's
	 * ending never waits on a turn that settlement holds.
	 */
	readonly recordEnding: (runId: string, ending: Turns.Ended) => Effect.Effect<boolean>;
	/**
	 * Records how a running run ended, and announces it. `false` when the run
	 * was not running. A failure pauses its automation when it is the
	 * `FAILURES_THAT_PAUSE`th in a row.
	 */
	readonly settle: (runId: string, settled: Settled) => Effect.Effect<boolean>;
	/**
	 * Records a run that has not ended as failed, telling people
	 * `userMessage`, and announces it, pausing its automation as `settle` does.
	 * Does nothing once the run has ended.
	 */
	readonly fail: (runId: string, userMessage: UserText) => Effect.Effect<void>;
	/**
	 * Turns on again the automation `automationId` when it paused itself after
	 * failing. `true` when it did, so when its routines next run is due to be set again.
	 */
	readonly resumeAfterFailures: (automationId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AutomationRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AutomationRepository");
	const { emit } = yield* ConversationEvents.Service;
	const runs = yield* AutomationRuns.Service;

	/** The automation's feed, which lists the run. */
	const listingOf = (run: schema.RunRow) =>
		Effect.gen(function* () {
			const [feed] = yield* query((db) =>
				db
					.select({ rootConversationId: automationFeed.conversationId })
					.from(automationFeed)
					.where(eq(automationFeed.automationId, run.automationId))
					.limit(1),
			);
			if (!feed) {
				return yield* Effect.die(new Error("An automation run's automation has no feed"));
			}
			return { rootConversationId: feed.rootConversationId };
		});

	/**
	 * Pauses the automation `automationId` when its last `FAILURES_THAT_PAUSE`
	 * finished runs all failed and it is still on, recording that it paused
	 * itself, and clears when its routines next run.
	 */
	const pauseAfterFailures = (automationId: string) =>
		Effect.gen(function* () {
			const paused = yield* query((db) =>
				db
					.update(automation)
					.set({ state: "paused", pausedAfterFailuresAt: sql`now()` })
					.where(
						and(
							eq(automation.id, automationId),
							eq(automation.state, "enabled"),
							isNull(automation.deletedAt),
							sql`(
							select count(*) from (
								select ${automationRun.state} as state from ${automationRun}
								where ${automationRun.automationId} = ${automationId}
									and ${automationRun.finishedAt} is not null
								order by ${automationRun.acceptedAt} desc, ${automationRun.id} desc
								limit ${FAILURES_THAT_PAUSE}
							) as latest
							where latest.state = 'failed'
						) = ${FAILURES_THAT_PAUSE}`,
						),
					)
					.returning({ id: automation.id }),
			);
			if (paused.length === 0) return;
			// A paused automation's routines have no next time.
			yield* query((db) =>
				db
					.update(automationTrigger)
					.set({ nextScheduledAt: null })
					.where(eq(automationTrigger.automationId, automationId)),
			);
		});

	/** Tells the workspace that a run's conversation changed because the run ended. */
	const announceEnded = (run: schema.RunRow) =>
		Effect.gen(function* () {
			yield* emit([
				ConversationEvent.RunSettled({
					workspaceId: run.workspaceId,
					...(yield* listingOf(run)),
					conversationId: run.conversationId,
				}),
			]);
		});

	return Service.of({
		resumeAfterFailures: (automationId) =>
			operation(
				"resumeAfterFailures",
				Effect.map(
					query((db) =>
						db
							.update(automation)
							.set({ state: "enabled", pausedAfterFailuresAt: null })
							.where(
								and(
									eq(automation.id, automationId),
									sql`${automation.pausedAfterFailuresAt} is not null`,
									isNull(automation.deletedAt),
								),
							)
							.returning({ id: automation.id }),
					),
					(resumed) => resumed.length > 0,
				),
			),

		create: (definition) =>
			operation(
				"create",
				queryCatching(
					(db) => db.insert(automation).values(definition).returning(),
					(rejection) => (isUniqueViolation(rejection) ? new AutomationNameTaken() : undefined),
				).pipe(Effect.flatMap(writtenRow("automation"))),
			),

		update: (scope, definition) =>
			operation(
				"update",
				Effect.map(
					queryCatching(
						(db) => db.update(automation).set(definition).where(inScope(scope)).returning(),
						(rejection) => (isUniqueViolation(rejection) ? new AutomationNameTaken() : undefined),
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
								.update(automation)
								.set({ deletedAt: now, state: "paused" })
								.where(inScope(scope))
								.returning({ id: automation.id }),
						);
						if (!removed) return false;
						yield* query((db) =>
							db
								.update(automationTrigger)
								.set({ nextScheduledAt: null })
								.where(eq(automationTrigger.automationId, removed.id)),
						);
						const cancelled = yield* query((db) =>
							db
								.update(automationRun)
								.set({ state: "cancelled", finishedAt: now })
								.where(
									and(
										eq(automationRun.automationId, removed.id),
										eq(automationRun.state, "queued"),
									),
								)
								.returning(),
						);
						for (const run of cancelled) {
							yield* announceEnded(run);
							yield* runs.settled({ automationId: run.automationId, runId: run.id });
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
								.insert(automationTrigger)
								.values(
									triggers.map((values) => ({
										...values,
										workspaceId: scope.workspaceId,
										automationId: scope.automationId,
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
						db
							.update(automationTrigger)
							.set(values)
							.where(ofAutomation(scope, triggerId))
							.returning(),
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
							.delete(automationTrigger)
							.where(ofAutomation(scope, triggerId))
							.returning({ id: automationTrigger.id }),
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
							.update(automationTrigger)
							.set({ secretEncrypted: sealed })
							.where(and(ofAutomation(scope, triggerId), eq(automationTrigger.kind, "webhook")))
							.returning({ id: automationTrigger.id }),
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
							.select({ trigger: automationTrigger, automation })
							.from(automationTrigger)
							.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
							.where(
								and(
									eq(automation.state, "enabled"),
									isNull(automation.deletedAt),
									sql`${automationTrigger.nextScheduledAt} <= ${now}`,
								),
							)
							.orderBy(asc(automationTrigger.nextScheduledAt), asc(automationTrigger.id))
							.limit(1)
							.for("update", { of: automationTrigger, skipLocked: true }),
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
								.update(automationTrigger)
								.set({ nextScheduledAt: at })
								.where(eq(automationTrigger.id, triggerId)),
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
							db.insert(automationRun).values(run).returning(),
						).pipe(Effect.flatMap(writtenRow("run")));
						yield* emit([
							ConversationEvent.RunAccepted({
								workspaceId: accepted.workspaceId,
								...(yield* listingOf(accepted)),
								conversationId: accepted.conversationId,
							}),
						]);
						return accepted;
					}),
				),
			),

		start: (runId) =>
			operation(
				"start",
				transaction(
					Effect.gen(function* () {
						const [execution] = yield* query((db) =>
							db
								.select()
								.from(automationRun)
								.where(eq(automationRun.id, runId))
								.limit(1)
								.for("update"),
						);
						if (execution?.state === "running") return execution;
						if (execution?.state !== "queued") return undefined;
						const startedAt = yield* DateTime.nowAsDate;
						return yield* query((db) =>
							db
								.update(automationRun)
								.set({ state: "running", startedAt })
								.where(eq(automationRun.id, runId))
								.returning(),
						).pipe(Effect.flatMap(writtenRow("run")));
					}),
				),
			),

		recordEnding: (runId, ending) =>
			operation(
				"recordEnding",
				Effect.gen(function* () {
					const running = and(eq(automationRun.id, runId), eq(automationRun.state, "running"));
					const [run] = yield* query((db) =>
						db.select().from(automationRun).where(running).limit(1).for("update"),
					);
					if (!run) return false;
					const was = endingOf(run);
					const merged = endingAfter(was, ending);
					if (merged === was) return false;
					yield* query((db) =>
						db
							.update(automationRun)
							.set({
								pendingTerminalState: merged?.state ?? null,
								pendingTerminalError: merged?.state === "failed" ? merged.error : null,
							})
							.where(running),
					);
					return was === undefined;
				}),
			),

		settle: (runId, settled) =>
			operation(
				"settle",
				transaction(
					Effect.gen(function* () {
						const finishedAt = yield* DateTime.nowAsDate;
						const [recorded] = yield* query((db) =>
							db
								.update(automationRun)
								.set({
									state: settled.state,
									error: settled.state === "failed" ? settled.error : null,
									finishedAt,
									pendingTerminalState: null,
									pendingTerminalError: null,
								})
								.where(and(eq(automationRun.id, runId), eq(automationRun.state, "running")))
								.returning(),
						);
						if (!recorded) return false;
						yield* announceEnded(recorded);
						if (recorded.state === "failed") yield* pauseAfterFailures(recorded.automationId);
						return true;
					}),
				),
			),

		fail: (runId, userMessage) =>
			operation(
				"fail",
				transaction(
					Effect.gen(function* () {
						const finishedAt = yield* DateTime.nowAsDate;
						const [failed] = yield* query((db) =>
							db
								.update(automationRun)
								.set({
									state: "failed",
									error: userMessage,
									finishedAt,
									pendingTerminalState: null,
									pendingTerminalError: null,
								})
								.where(
									and(
										eq(automationRun.id, runId),
										inArray(automationRun.state, ["queued", "running"]),
									),
								)
								.returning(),
						);
						if (!failed) return;
						yield* announceEnded(failed);
						yield* pauseAfterFailures(failed.automationId);
					}),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** What an automation is: its name, what it tells the bot, where its result goes, and whether it runs. */
export type Definition = Pick<schema.AutomationRow, "name" | "instructions" | "state">;

/** What one of an automation's triggers is, and what it keeps beside that: a webhook's secret, a routine's next time. */
export type TriggerValues = Pick<
	schema.AutomationTriggerRow,
	"settings" | "secretEncrypted" | "nextScheduledAt"
>;

/** The trigger `triggerId`, when it is one of the automation `scope` names, which hasn't been removed. */
const ofAutomation = (scope: Scope, triggerId: string) =>
	and(
		eq(automationTrigger.id, triggerId),
		eq(automationTrigger.automationId, scope.automationId),
		eq(automationTrigger.workspaceId, scope.workspaceId),
		sql`exists (select 1 from ${automation} where ${inScope(scope)})`,
	);

/** Failed runs in a row after which an automation pauses itself. */
const FAILURES_THAT_PAUSE = 2;

/** How a run's work ended. */
export type Settled = Turns.Ended | { readonly state: "completed" };

export class AutomationNameTaken
	extends Data.TaggedError("AutomationNameTaken")
	implements UserFacing
{
	get userMessage() {
		return userText`An automation with that name already exists`;
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
export function endingOf(run: schema.RunRow): Turns.Ended | undefined {
	if (run.pendingTerminalState === "cancelled") return { state: "cancelled" };
	if (run.pendingTerminalState === "failed") {
		// `pending_terminal_error` is nullable in the schema; a failure recorded
		// without one reads as having stopped unexpectedly.
		return { state: "failed", error: run.pendingTerminalError ?? RUN_STOPPED_UNEXPECTEDLY };
	}
	return undefined;
}

/** What people are told about a run whose workflow failed; the cause goes only to the logs. */
export const RUN_STOPPED_UNEXPECTEDLY = userText`The automation run stopped unexpectedly`;

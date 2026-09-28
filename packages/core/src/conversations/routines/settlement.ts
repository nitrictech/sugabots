export * as RoutineSettlement from "./settlement.ts";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import {
	collaboration,
	type RoutineExecutionRow,
	routineExecution,
	thread,
	turn,
} from "../../database/schema.ts";
import { UserMessage } from "../../user-message.ts";
import { dropWaiting, laneBusy } from "../../workflows/lanes.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { Facilitate } from "../floor/facilitate.workflow.ts";
import { workingThreadsOf } from "../threads/tree.ts";
import { CollaborationRepository } from "../tools/collaborate/repository.ts";
import { Turns } from "../turns/turns.ts";
import { findRoutineExecutionId, lockRoutineSettlement } from "./execution.ts";
import { RoutineRepository } from "./repository.ts";
import type { RoutineRun } from "./routine.workflow.ts";
import { RoutineRuns } from "./runs.ts";

/**
 * Settles routine runs: records how a run ended once nothing in its threads
 * is running, waiting or about to start.
 *
 * `handler` reacts to the conversation events that can end a run, inside the
 * transaction that emitted them. A turn or facilitation that failed for good,
 * or a turn that was cancelled, starts ending its run early: the rest of the
 * run's work is cancelled, and the run ends that way once what is still
 * running stops. Every later settlement of an ending run cancels whatever
 * work is left, since some may have been held by another transaction.
 */
export interface Interface {
	readonly handler: DomainEvents.Handler<ConversationEvent>;
	/**
	 * Settles the run if its work is done, for the run's workflow to check in
	 * case a signal was lost. Returns whether the run has ended.
	 */
	readonly settleRun: (run: RoutineRun) => Effect.Effect<boolean>;
	/**
	 * Records a run that has not ended as failed, at once, and stops its work.
	 * People are told only that it stopped unexpectedly. Does nothing once the
	 * run has ended.
	 */
	readonly failRun: (run: RoutineRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/RoutineSettlement",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineSettlement");
	const { emit } = yield* ConversationEvents.Service;
	const turns = yield* Turns.Service;
	const collaborations = yield* CollaborationRepository.Service;
	const routines = yield* RoutineRepository.Service;
	const runs = yield* RoutineRuns.Service;

	/** Cancels the work still going on in the run's threads `work`. */
	const cancelWork = (work: readonly string[]) =>
		Effect.gen(function* () {
			yield* collaborations.failUnder(work);
			yield* turns.stopUnder(work);
			yield* query((db) => db.execute(dropWaiting(threadIdsRelation(work), [Facilitate._tag])));
		});

	/**
	 * Settles the running routine run the thread `threadId` belongs to, if its
	 * work is done, first adding `outcome` to how it is ending.
	 */
	const settle = (threadId: string, outcome?: Turns.Ended) =>
		transaction(
			Effect.gen(function* () {
				const executionId = yield* query((db) => findRoutineExecutionId(db, threadId));
				if (!executionId) return;
				yield* lockRoutineSettlement(executionId);
				const run = yield* runningRun(executionId);
				if (!run) return;
				const work = yield* workingThreads(run.threadId);
				const wasEnding = endingOf(run);
				const ending = endingAfter(wasEnding, outcome);
				if (ending && ending !== wasEnding) yield* routines.recordEnding(run.id, ending);
				if (ending) yield* cancelWork(work);
				if (ending && !wasEnding) {
					yield* emit([
						ConversationEvent.RoutineWorkCancelled({
							workspaceId: run.workspaceId,
							podId: yield* podOf(run.threadId),
							threadIds: work,
						}),
					]);
				}
				if (yield* stillBusy(work, ending !== undefined)) return;
				if (yield* routines.settle(run.id, settledAs(ending, yield* lastTurnIn(work)))) {
					yield* runs.settled({ routineId: run.routineId, executionId: run.id });
				}
			}),
		);

	return Service.of({
		handler: (events) =>
			Effect.forEach(
				events.flatMap(settlementFor),
				({ threadId, outcome }) => settle(threadId, outcome),
				{ discard: true },
			),

		settleRun: (run) =>
			operation(
				"settleRun",
				Effect.gen(function* () {
					const threadId = yield* executionThread(run.executionId);
					if (!threadId) return true;
					yield* settle(threadId);
					const [after] = yield* query((db) =>
						db
							.select({ state: routineExecution.state })
							.from(routineExecution)
							.where(eq(routineExecution.id, run.executionId))
							.limit(1),
					);
					return after?.state !== "running";
				}),
			),

		failRun: (run) =>
			operation(
				"failRun",
				transaction(
					Effect.gen(function* () {
						yield* lockRoutineSettlement(run.executionId);
						const threadId = yield* executionThread(run.executionId);
						if (threadId) {
							yield* settle(threadId, { state: "failed", error: RUN_STOPPED_UNEXPECTEDLY });
						}
						// Settling waits for work that is still stopping, but the run ends
						// now: its routine's next run cannot start while it is running.
						yield* routines.fail(run.executionId, RUN_STOPPED_UNEXPECTEDLY);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([CollaborationRepository.layer, RoutineRepository.layer]),
);

/** What people are told about a run whose workflow failed; the cause goes only to the logs. */
const RUN_STOPPED_UNEXPECTEDLY = UserMessage.of`The routine run stopped unexpectedly`;

/** The thread an event may let a routine run settle in, and how the run ends if it ends it early. */
function settlementFor(
	event: ConversationEvent,
): Array<{ readonly threadId: string; readonly outcome?: Turns.Ended }> {
	switch (event._tag) {
		case "TurnCompleted":
		case "LaneReleased":
			return [{ threadId: event.threadId }];
		case "TurnFailed":
			// A turn that runs again has not failed for good.
			return event.willRetry
				? []
				: [{ threadId: event.threadId, outcome: { state: "failed", error: event.userMessage } }];
		case "TurnCancelled":
			return [{ threadId: event.threadId, outcome: { state: "cancelled" } }];
		case "TurnAbandoned":
			return [{ threadId: event.threadId, outcome: event.outcome }];
		case "FacilitationFailed":
			return [{ threadId: event.threadId, outcome: { state: "failed", error: event.userMessage } }];
		case "CollaborationAnswered":
		case "CollaborationStoppedWaiting":
			return [{ threadId: event.parentThreadId }];
		default:
			return [];
	}
}

/**
 * endingAfter returns how a run ends once `outcome` is added to `ending`, how
 * it was already ending. A failure stands over a cancellation.
 */
function endingAfter(
	ending: Turns.Ended | undefined,
	outcome: Turns.Ended | undefined,
): Turns.Ended | undefined {
	if (!outcome || ending?.state === "failed") return ending;
	return outcome;
}

/** settledAs returns how a run whose work is over ends: as it was ending, or else as its last turn did. */
function settledAs(
	ending: Turns.Ended | undefined,
	lastTurn: { status: string; error: UserMessage | null } | undefined,
): RoutineRepository.Settled {
	if (ending) return ending;
	if (lastTurn?.status === "failed") {
		// `turn.error` is nullable in the schema; a failure recorded without one
		// reads as having stopped unexpectedly.
		return { state: "failed", error: lastTurn.error ?? RUN_STOPPED_UNEXPECTEDLY };
	}
	if (lastTurn?.status === "cancelled") return { state: "cancelled" };
	return { state: "completed" };
}

/** The run, if it is still running. */
const runningRun = (executionId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(routineExecution)
				.where(and(eq(routineExecution.id, executionId), eq(routineExecution.state, "running")))
				.limit(1),
		),
		([row]) => row,
	);

/** How the run is already ending, if something has started ending it. */
function endingOf(run: RoutineExecutionRow): Turns.Ended | undefined {
	if (run.pendingTerminalState === "cancelled") return { state: "cancelled" };
	if (run.pendingTerminalState === "failed") {
		// `pending_terminal_error` is nullable in the schema; a failure recorded
		// without one reads as having stopped unexpectedly.
		return { state: "failed", error: run.pendingTerminalError ?? RUN_STOPPED_UNEXPECTEDLY };
	}
	return undefined;
}

/** The pod the thread `threadId` is in. */
const podOf = (threadId: string) =>
	Effect.flatMap(
		query((db) =>
			db.select({ podId: thread.podId }).from(thread).where(eq(thread.id, threadId)).limit(1),
		),
		([row]) =>
			row ? Effect.succeed(row.podId) : Effect.die(new Error("A routine run's thread is gone")),
	);

const executionThread = (executionId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ threadId: routineExecution.threadId })
				.from(routineExecution)
				.where(eq(routineExecution.id, executionId))
				.limit(1),
		),
		([row]) => row?.threadId,
	);

/** The threads a run's work happens in, under its own thread `rootThreadId` (see `workingThreadsOf`). */
const workingThreads = (rootThreadId: string) =>
	Effect.map(
		query((db) =>
			db.execute<{ id: string }>(
				sql`select id from ${workingThreadsOf(sql`${rootThreadId}`)} as work`,
				"objects",
			),
		),
		(rows) => rows.map(({ id }) => id),
	);

/** `threadIds` as a subquery of one uuid column. */
const threadIdsRelation = (threadIds: readonly string[]) =>
	sql`select unnest(array[${sql.join(
		threadIds.map((id) => sql`${id}`),
		sql`, `,
	)}]::uuid[])`;

/**
 * stillBusy reports whether work in the threads `work` keeps the run from
 * settling. Until the run is `ending`, that is anything running, waiting or
 * asked for. An ending run waits only for its running turns, which record how
 * they ended, and its running facilitations: its waiting turns and
 * collaborations were cancelled, and the turns its workflows still ask for
 * are refused.
 */
const stillBusy = (work: readonly string[], ending: boolean) =>
	Effect.map(
		query((db) =>
			db.execute<{ busy: boolean }>(
				sql`select (
					exists (
						select 1 from (${threadIdsRelation(work)}) as work(id)
						where ${
							ending
								? laneBusy(sql`work.id`, [Facilitate._tag])
								: sql`(${Turns.busyIn(sql`work.id`)} or ${laneBusy(sql`work.id`, [Facilitate._tag])})`
						}
					)
					or exists (
						select 1 from ${turn}
						where ${inArray(turn.threadId, [...work])}
							and ${inArray(turn.status, ending ? ["running"] : ["running", "waiting"])}
					)
					${ending ? sql`` : sql`or ${unansweredCollaborations(work)}`}
				) as busy`,
				"objects",
			),
		),
		([row]) => row?.busy ?? false,
	);

const unansweredCollaborations = (work: readonly string[]) =>
	sql`exists (
		select 1 from ${collaboration}
		where ${inArray(collaboration.parentThreadId, [...work])}
			and ${inArray(collaboration.status, ["waiting", "pending"])}
	)`;

/** How the last turn to end in the threads `work` ended, if any has. */
const lastTurnIn = (work: readonly string[]) =>
	Effect.map(
		query((db) =>
			db
				.select({ status: turn.status, error: turn.error })
				.from(turn)
				.where(inArray(turn.threadId, [...work]))
				.orderBy(sql`${turn.finishedAt} desc nulls last`, desc(turn.id))
				.limit(1),
		),
		([row]) => row,
	);

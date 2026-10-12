export * as RoutineSettlement from "./settlement.ts";

import { textWithoutNarration } from "@sugabots/contracts";
import type { UserText } from "@sugabots/errors";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	afterCommit,
	batchedBeforeCommit,
	Database,
	query,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import type * as schema from "../../database/schema.ts";
import {
	chat,
	collaboration,
	message,
	routineExecution,
	thread,
	turn,
} from "../../database/schema.ts";
import { Lanes, laneBusy } from "../../workflows/lanes.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { Facilitate } from "../floor/facilitate.workflow.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { workingThreadsOf } from "../threads/tree.ts";
import { Collaborations } from "../tools/collaborate/collaborations.ts";
import { Turns } from "../turns/turns.ts";
import { findRoutineExecutionId, lockRoutineSettlement } from "./execution.ts";
import {
	endingAfter,
	endingOf,
	RoutineRepository,
	RUN_STOPPED_UNEXPECTEDLY,
} from "./repository.ts";
import type { RoutineRun } from "./routine.workflow.ts";
import { RoutineRuns } from "./runs.ts";

/**
 * Settles routine runs: records how a run ended once nothing in its threads
 * is running, waiting or about to start. A completed run whose results are
 * posted to the chat has its agent's last reply posted there.
 *
 * `handler` reacts to the conversation events that can end a run. In the
 * emitting transaction it only records how an event says the run should end,
 * without locking the run; the run settles once that transaction commits, in
 * its own. A turn or facilitation that failed for good, or a turn that was
 * cancelled, starts ending its run early: the rest of its work is cancelled, and it ends that way once what is still running
 * stops. Every later settlement of an ending run cancels whatever work is
 * left, since some may have been held by another transaction. A settlement
 * lost to a crash after commit is made by the run's workflow's next check.
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
	const collaborations = yield* Collaborations.Service;
	const lanes = yield* Lanes.Service;
	const routines = yield* RoutineRepository.Service;
	const runs = yield* RoutineRuns.Service;
	const threads = yield* ThreadRepository.Service;

	/**
	 * Posts the agent's last reply in the run's own thread into its chat. A
	 * run whose agent wrote nothing to show posts nothing.
	 */
	const postResult = (run: schema.RoutineExecutionRow) =>
		Effect.gen(function* () {
			const content = (yield* lastReplyText(run)).trim();
			if (content === "") return;
			yield* threads.postRoutineResult({
				threadId: yield* chatThreadOf(run.threadId),
				run,
				content,
			});
		});

	/**
	 * Cancels the work still going on in the run's threads `work`. Turns before
	 * collaborations, the order a turn writer takes them in when ending a turn
	 * fails its collaboration, so the two never wait on each other.
	 */
	const cancelWork = (work: readonly string[]) =>
		Effect.gen(function* () {
			yield* turns.stopUnder(work);
			yield* collaborations.failUnder(work);
			yield* lanes.dropWaiting(work, [Facilitate._tag]);
		});

	/**
	 * Settles the running routine run the thread `threadId` belongs to, if its
	 * work is done, first adding `outcome` to how it is ending. `announce` says
	 * the run started ending since it last settled, so watching clients are
	 * told its work was cancelled.
	 *
	 * The run is read without locking it, and written only after its work is
	 * cancelled (see `RoutineRepository.recordEnding`). An ending recorded
	 * after the read settles the run again once its transaction commits.
	 */
	const settle = (threadId: string, options: { outcome?: Turns.Ended; announce?: boolean } = {}) =>
		transaction(
			Effect.gen(function* () {
				const executionId = yield* query((db) => findRoutineExecutionId(db, threadId));
				if (!executionId) return;
				yield* lockRoutineSettlement(executionId);
				const run = yield* runningRun(executionId);
				if (!run) return;
				const work = yield* workingThreads(run.threadId);
				const wasEnding = endingOf(run);
				const ending = endingAfter(wasEnding, options.outcome);
				if (ending) yield* cancelWork(work);
				if (ending && (options.announce || !wasEnding)) {
					yield* emit([
						ConversationEvent.RoutineWorkCancelled({
							workspaceId: run.workspaceId,
							podId: yield* podOf(run.threadId),
							threadIds: work,
						}),
					]);
				}
				if (ending && ending !== wasEnding) yield* routines.recordEnding(run.id, ending);
				if (yield* stillBusy(work, ending !== undefined)) return;
				const settled = settledAs(ending, yield* lastTurnIn(work));
				if (!(yield* routines.settle(run.id, settled))) return;
				if (settled.state === "completed" && run.results === "post_to_chat") {
					yield* postResult(run);
				}
				yield* runs.settled({ routineId: run.routineId, executionId: run.id });
			}),
		);

	/**
	 * Settles the runs of these threads once the transaction commits. Batched,
	 * so it is registered after the thread feed's outbox, which the handlers
	 * reach first: clients hear what a turn did before they hear its run settled.
	 */
	const settleAfterCommit = batchedBeforeCommit(
		(settlements: ReadonlyArray<{ threadId: string; announce: boolean }>) =>
			Effect.flatMap(Database, (database) => {
				const announced = new Map<string, boolean>();
				for (const { threadId, announce } of settlements) {
					announced.set(threadId, announce || (announced.get(threadId) ?? false));
				}
				return afterCommit(
					Effect.forEach(announced, ([threadId, announce]) => settle(threadId, { announce }), {
						discard: true,
					}).pipe(Effect.provideService(Database, database)),
				);
			}),
	);

	return Service.of({
		handler: (events) =>
			Effect.gen(function* () {
				const settlements = yield* Effect.forEach(
					events.flatMap(settlementFor),
					({ threadId, outcome }) =>
						Effect.gen(function* () {
							if (!outcome) return { threadId, announce: false };
							const executionId = yield* query((db) => findRoutineExecutionId(db, threadId));
							const started = executionId
								? yield* routines.recordEnding(executionId, outcome)
								: false;
							return { threadId, announce: started };
						}),
				);
				yield* settleAfterCommit(settlements);
			}),

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
							yield* settle(threadId, {
								outcome: { state: "failed", error: RUN_STOPPED_UNEXPECTEDLY },
							});
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
	Layer.provide([Collaborations.layer, RoutineRepository.layer, ThreadRepository.layer]),
);

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

/** settledAs returns how a run whose work is over ends: as it was ending, or else as its last turn did. */
function settledAs(
	ending: Turns.Ended | undefined,
	lastTurn: { status: string; error: UserText | null } | undefined,
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

/** The pod the thread `threadId` is in. */
const podOf = (threadId: string) =>
	Effect.flatMap(
		query((db) =>
			db.select({ podId: thread.podId }).from(thread).where(eq(thread.id, threadId)).limit(1),
		),
		([row]) =>
			row ? Effect.succeed(row.podId) : Effect.die(new Error("A routine run's thread is gone")),
	);

/** The main thread of the chat the run's thread `threadId` is in. */
const chatThreadOf = (threadId: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ mainThreadId: chat.mainThreadId })
				.from(thread)
				.innerJoin(chat, eq(chat.id, thread.chatId))
				.where(eq(thread.id, threadId))
				.limit(1),
		),
		([row]) =>
			row
				? Effect.succeed(row.mainThreadId)
				: Effect.die(new Error("A routine run's thread is not in a chat")),
	);

/**
 * The text of the agent's last finished reply in the run's own thread, as the
 * thread shows it. Its collaborators' threads are their work, not its answer.
 */
const lastReplyText = (run: schema.RoutineExecutionRow) =>
	Effect.map(
		query((db) =>
			db
				.select({ parts: message.parts })
				.from(message)
				.where(
					and(
						eq(message.threadId, run.threadId),
						eq(message.authorAgentId, run.agentId),
						eq(message.status, "complete"),
					),
				)
				.orderBy(desc(message.createdAt), desc(message.id))
				.limit(1),
		),
		([row]) => (row ? textWithoutNarration(row.parts) : ""),
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

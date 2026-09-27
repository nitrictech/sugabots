/**
 * A routine's run, as a durable workflow. It holds only the definition: what
 * each step does lives behind `RoutineSteps`, implemented in `steps.ts`.
 *
 * A run starts its turn, then waits until settlement records how it ended.
 * Runs of one routine wait in its lane, so they happen one at a time.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Duration, Effect, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";

export const RoutineRun = Schema.Struct({
	routineId: Schema.String,
	executionId: Schema.String,
});
export type RoutineRun = typeof RoutineRun.Type;

export const Routine = Workflow.make("routine", {
	payload: RoutineRun,
	idempotencyKey: (run) => run.executionId,
});

/** One run at a time per routine. */
export const routineLane = (run: Pick<RoutineRun, "routineId">) => `routine:${run.routineId}`;

/** Settlement recorded how the run ended. */
export const routineSettled = DurableDeferred.make("settled");

export class RoutineSteps extends Context.Service<
	RoutineSteps,
	{
		/** Marks the run started and asks for its turn. Does nothing once the run has ended. */
		readonly start: (run: RoutineRun) => Effect.Effect<void>;
		/** Settles the run if its work is done. Returns whether it has ended. */
		readonly settle: (run: RoutineRun) => Effect.Effect<boolean>;
		/** Frees the routine's lane for its next run. */
		readonly release: (run: RoutineRun) => Effect.Effect<void>;
	}
>()("@sugabots/core/RoutineSteps") {}

export const routineActivities = Activities.make<RoutineRun>()({
	start: {
		execute: (run) => Effect.flatMap(Effect.service(RoutineSteps), (steps) => steps.start(run)),
	},
	settle: {
		success: Schema.Boolean,
		execute: (run) => Effect.flatMap(Effect.service(RoutineSteps), (steps) => steps.settle(run)),
	},
	release: {
		execute: (run) => Effect.flatMap(Effect.service(RoutineSteps), (steps) => steps.release(run)),
	},
});

/**
 * Settlement signals the run once it has ended, after its transaction commits.
 * A signal lost to a crash in between is covered by checking again this often.
 */
const SETTLEMENT_CHECK_INTERVAL = Duration.minutes(1);

/**
 * Whatever happens to the run, the lane is released so the routine's next run
 * can start. A suspension surfaces here as an interruption, but the run is not
 * over, so it passes through untouched.
 */
export const routineWorkflow = (run: RoutineRun) =>
	Effect.gen(function* () {
		const ended = yield* Effect.exit(runToSettlement(run));
		const instance = yield* WorkflowEngine.WorkflowInstance;
		if (instance.suspended) return yield* ended;
		yield* routineActivities.activity("release", run);
		return yield* ended;
	});

const runToSettlement = (run: RoutineRun) =>
	Effect.gen(function* () {
		yield* routineActivities.activity("start", run);
		for (let round = 0; ; round++) {
			if (yield* routineActivities.activity("settle", run, `${round}`)) return;
			yield* DurableDeferred.raceAll({
				name: `settlement/${round}`,
				success: Schema.Void,
				error: Schema.Never,
				effects: [
					DurableDeferred.await(routineSettled),
					DurableClock.sleep({ name: `check/${round}`, duration: SETTLEMENT_CHECK_INTERVAL }),
				],
			});
		}
	});

/** Tells a run's workflow that settlement recorded how it ended. */
export const signalSettled = (run: RoutineRun) =>
	Effect.flatMap(Routine.executionId(run), (executionId) =>
		DurableDeferred.succeed(routineSettled, {
			token: DurableDeferred.tokenFromExecutionId(routineSettled, {
				workflow: Routine,
				executionId,
			}),
			value: undefined,
		}),
	);

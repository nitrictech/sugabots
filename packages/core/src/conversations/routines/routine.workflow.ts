/**
 * A routine's run, as a durable workflow: its definition and the order of its
 * steps. What each step does lives behind `RoutineSteps`, implemented in
 * `steps.ts`.
 *
 * A run starts its turn, then waits until settlement records how it ended.
 * Runs of one routine wait in its lane, so they happen one at a time.
 */
import { Activities } from "@sugabots/workflow/activities";
import { Context, Duration, Effect, Schema } from "effect";
import { DurableClock, DurableDeferred, Workflow } from "effect/unstable/workflow";
import { Lanes } from "../../workflows/lanes.ts";

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
const routineSettled = DurableDeferred.make("settled");

export class RoutineSteps extends Context.Service<
	RoutineSteps,
	{
		/** Marks the run started and asks for its turn. Does nothing once the run has ended. */
		readonly start: (run: RoutineRun) => Effect.Effect<void>;
		/** Settles the run if its work is done. Returns whether it has ended. */
		readonly settle: (run: RoutineRun) => Effect.Effect<boolean>;
		/** Records the run as failed, stopping its work, when its workflow fails. */
		readonly fail: (run: RoutineRun) => Effect.Effect<void>;
	}
>()("@sugabots/core/RoutineSteps") {}

/** Each check whether the run has settled is a separate activity, numbered from 0. */
const routineActivities = Activities.fromService<RoutineRun>()(RoutineSteps, {
	start: {},
	settle: { input: Schema.Int, success: Schema.Boolean },
	fail: {},
});

/**
 * Settlement signals the run once it has ended, after its transaction commits.
 * A signal lost to a crash in between is covered by checking again this often.
 */
const SETTLEMENT_CHECK_INTERVAL = Duration.minutes(1);

export const routineWorkflow = Lanes.workflow(Routine, {
	lane: routineLane,
	activities: routineActivities,
	body: (run) =>
		Effect.gen(function* () {
			yield* routineActivities.activity("start", run);
			for (let check = 0; ; check++) {
				if (yield* routineActivities.activity("settle", run, check)) return;
				yield* DurableDeferred.raceAll({
					name: `settlement/${check}`,
					success: Schema.Void,
					error: Schema.Never,
					effects: [
						DurableDeferred.await(routineSettled),
						DurableClock.sleep({ name: `check/${check}`, duration: SETTLEMENT_CHECK_INTERVAL }),
					],
				});
			}
		}),
	onFailure: "fail",
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

import { Effect } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit, type Database } from "../../database/database.ts";
import type { Lanes } from "../../workflows/lanes.ts";
import { Routine, type RoutineRun, routineLane, signalSettled } from "./routine.workflow.ts";

/**
 * How a routine's runs are started and told they have ended. Given to the
 * routine store, so how runs are carried out can change without it.
 */
export interface RoutineRuns {
	/** Asks for the run, in the caller's transaction. It starts once the routine's earlier runs end. */
	readonly queue: (run: RoutineRun) => Effect.Effect<void, never, Database>;
	/** Tells the run's workflow that it has ended, once the caller's transaction commits. */
	readonly settled: (run: RoutineRun) => Effect.Effect<void>;
}

/** Runs as routine workflows, one at a time per routine. */
export const routineRunsInLanes = (
	lanes: Lanes.Interface,
	engine: WorkflowEngine.WorkflowEngine["Service"],
): RoutineRuns => ({
	queue: (run) =>
		lanes
			.admit({ key: routineLane(run), workflow: Routine, payload: run, whenBusy: "queue" })
			.pipe(Effect.asVoid),
	settled: (run) =>
		afterCommit(
			signalSettled(run).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
		),
});

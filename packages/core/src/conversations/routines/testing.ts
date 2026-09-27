import { and, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit, query } from "../../database/database.ts";
import { lane } from "../../workflows/sql.ts";
import { engineForTests, lanesForTests } from "../../workflows/testing.ts";
import { Routine, RoutineRun, routineLane, signalSettled } from "./routine.workflow.ts";
import { type RoutineRuns, routineRunsInLanes } from "./runs.ts";

/**
 * Routine runs for the Postgres cases. They are queued through real lanes, but
 * a run's workflow here only holds its lane: a case starts the run itself,
 * with `runningRun`, and frees the lane with `releaseRun`.
 */
export const routineRunsForTests: RoutineRuns = {
	queue: (run) =>
		Effect.flatMap(lanesForTests, (lanes) => routineRunsInLanes(lanes, engineForTests).queue(run)),
	settled: (run) =>
		afterCommit(
			signalSettled(run).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engineForTests)),
		),
};

/** The routine's run holding its lane, if any. */
export const runningRun = (routineId: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(lane)
				.where(
					and(
						eq(lane.key, routineLane({ routineId })),
						eq(lane.workflow, Routine._tag),
						ne(lane.state, "idle"),
					),
				),
		),
		([row]) => (row ? Schema.decodeUnknownSync(RoutineRun)(row.payload) : undefined),
	);

/** Frees the routine's lane, as its run's last step does, starting its next run. */
export const releaseRun = (run: RoutineRun) =>
	Effect.flatMap(lanesForTests, (lanes) =>
		Effect.flatMap(Routine.executionId(run), (executionId) =>
			lanes.release({ key: routineLane(run), executionId }),
		),
	);

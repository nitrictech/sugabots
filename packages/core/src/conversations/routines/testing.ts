import { and, eq, ne } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { query } from "../../database/database.ts";
import { lane } from "../../workflows/sql.ts";
import { lanesForTests } from "../../workflows/testing.ts";
import { Routine, RoutineRun, routineLane } from "./routine.workflow.ts";

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

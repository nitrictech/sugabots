import { Effect, Layer } from "effect";
import { Database } from "../../database/database.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { Routine, RoutineSteps, routineLane } from "./routine.workflow.ts";
import type { RoutineStore } from "./store.ts";

/**
 * The routine workflow's steps: starting a run, settling it, and freeing the
 * routine's lane afterwards. Activities reach them through `RoutineSteps`.
 */
export const stepsLayer = (store: Pick<RoutineStore, "startRun" | "settleRun">) =>
	Layer.effect(
		RoutineSteps,
		Effect.gen(function* () {
			const database = yield* Database;
			const lanes = yield* Lanes.Service;
			return RoutineSteps.of({
				start: (run) => store.startRun(run).pipe(Effect.provideService(Database, database)),
				settle: (run) => store.settleRun(run).pipe(Effect.provideService(Database, database)),
				release: (run) =>
					Effect.flatMap(Routine.executionId(run), (executionId) =>
						lanes.release({ key: routineLane(run), executionId }),
					),
			});
		}),
	);

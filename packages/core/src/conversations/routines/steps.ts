import { Effect, Layer } from "effect";
import { Database } from "../../database/database.ts";
import { RoutineSteps } from "./routine.workflow.ts";
import { RoutineSettlement } from "./settlement.ts";
import type { RoutineStore } from "./store.ts";

/** The routine workflow's steps, which its activities reach through `RoutineSteps`. */
export const stepsLayer = (dependencies: { routines: Pick<RoutineStore, "startRun"> }) =>
	Layer.effect(
		RoutineSteps,
		Effect.gen(function* () {
			const database = yield* Database;
			const settlement = yield* RoutineSettlement.Service;
			return RoutineSteps.of({
				start: (run) =>
					dependencies.routines.startRun(run).pipe(Effect.provideService(Database, database)),
				settle: settlement.settleRun,
				fail: settlement.failRun,
			});
		}),
	);

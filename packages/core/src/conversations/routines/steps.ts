import { Effect, Layer } from "effect";
import { Database } from "../../database/database.ts";
import { RoutineSteps } from "./routine.workflow.ts";
import type { RoutineSettlement } from "./settlement.ts";
import type { RoutineStore } from "./store.ts";

/** The routine workflow's steps, which its activities reach through `RoutineSteps`. */
export const stepsLayer = (dependencies: {
	routines: Pick<RoutineStore, "startRun">;
	settlement: Pick<RoutineSettlement.Interface, "settleRun" | "failRun">;
}) =>
	Layer.effect(
		RoutineSteps,
		Effect.gen(function* () {
			const database = yield* Database;
			return RoutineSteps.of({
				start: (run) =>
					dependencies.routines.startRun(run).pipe(Effect.provideService(Database, database)),
				settle: (run) =>
					dependencies.settlement.settleRun(run).pipe(Effect.provideService(Database, database)),
				fail: (run) =>
					dependencies.settlement.failRun(run).pipe(Effect.provideService(Database, database)),
			});
		}),
	);

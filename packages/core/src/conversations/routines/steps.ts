import { Effect, Layer } from "effect";
import { Database } from "../../database/database.ts";
import { RoutineSteps } from "./routine.workflow.ts";
import type { RoutineStore } from "./store.ts";

/** The routine workflow's steps, which its activities reach through `RoutineSteps`. */
export const stepsLayer = (store: Pick<RoutineStore, "startRun" | "settleRun" | "failRun">) =>
	Layer.effect(
		RoutineSteps,
		Effect.gen(function* () {
			const database = yield* Database;
			return RoutineSteps.of({
				start: (run) => store.startRun(run).pipe(Effect.provideService(Database, database)),
				settle: (run) => store.settleRun(run).pipe(Effect.provideService(Database, database)),
				fail: (run) => store.failRun(run).pipe(Effect.provideService(Database, database)),
			});
		}),
	);

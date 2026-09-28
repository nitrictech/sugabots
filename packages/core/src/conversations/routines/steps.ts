import { Effect, Layer } from "effect";
import { RoutineSteps } from "./routine.workflow.ts";
import { Routines } from "./routines.ts";
import { RoutineSettlement } from "./settlement.ts";

/** The routine workflow's steps, which its activities reach through `RoutineSteps`. */
export const stepsLayer = Layer.effect(
	RoutineSteps,
	Effect.gen(function* () {
		const routines = yield* Routines.Service;
		const settlement = yield* RoutineSettlement.Service;
		return RoutineSteps.of({
			start: routines.startRun,
			settle: settlement.settleRun,
			fail: settlement.failRun,
		});
	}),
);

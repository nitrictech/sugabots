import { Effect, Layer } from "effect";
import { RoutineSteps } from "./routine.workflow.ts";
import { RoutineRunner } from "./routine-runner.ts";
import { RoutineSettlement } from "./settlement.ts";

/** The routine workflow's steps, which its activities reach through `RoutineSteps`. */
export const routineStepsLayer = Layer.effect(
	RoutineSteps,
	Effect.gen(function* () {
		const runner = yield* RoutineRunner.Service;
		const settlement = yield* RoutineSettlement.Service;
		return RoutineSteps.of({
			start: runner.startRun,
			settle: settlement.settleRun,
			fail: settlement.failRun,
		});
	}),
);

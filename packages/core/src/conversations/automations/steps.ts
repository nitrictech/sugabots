import { Effect, Layer } from "effect";
import { AutomationSteps, runOfStored } from "./automation.workflow.ts";
import { AutomationRunner } from "./automation-runner.ts";
import { AutomationSettlement } from "./settlement.ts";

/** The automation workflow's steps, which its activities reach through `AutomationSteps`. */
export const automationStepsLayer = Layer.effect(
	AutomationSteps,
	Effect.gen(function* () {
		const runner = yield* AutomationRunner.Service;
		const settlement = yield* AutomationSettlement.Service;
		return AutomationSteps.of({
			start: (stored) => runner.startRun(runOfStored(stored)),
			settle: (stored) => settlement.settleRun(runOfStored(stored)),
			fail: (stored) => settlement.failRun(runOfStored(stored)),
		});
	}),
);

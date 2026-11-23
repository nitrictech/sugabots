export * as AutomationRuns from "./runs.ts";

import { Context, Effect, Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit } from "../../database/database.ts";
import { Lanes } from "../../workflows/lanes.ts";
import {
	Automation,
	type AutomationRun,
	automationLane,
	signalSettled,
} from "./automation.workflow.ts";

/** Starts automation runs, one at a time per automation, and tells them when they have ended. */
export interface Interface {
	/** Asks for the run, in the caller's transaction. It starts once the automation's earlier runs end. */
	readonly queue: (run: AutomationRun) => Effect.Effect<void>;
	/** Tells the run's workflow that it has ended, once the caller's transaction commits. */
	readonly settled: (run: AutomationRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/AutomationRuns",
) {}

export const make = Effect.gen(function* () {
	const lanes = yield* Lanes.Service;
	const engine = yield* WorkflowEngine.WorkflowEngine;
	return Service.of({
		queue: (run) =>
			lanes
				.admit({
					key: automationLane(run),
					workflow: Automation,
					payload: run,
					whenBusy: "queue",
				})
				.pipe(Effect.asVoid),
		settled: (run) =>
			afterCommit(
				signalSettled(run).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
			),
	});
});

export const layer = Layer.effect(Service, make);

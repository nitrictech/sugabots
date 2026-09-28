export * as RoutineRuns from "./runs.ts";

import { Context, Effect, Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit } from "../../database/database.ts";
import { Lanes } from "../../workflows/lanes.ts";
import { Routine, type RoutineRun, routineLane, signalSettled } from "./routine.workflow.ts";

/** Starts routine runs, one at a time per routine, and tells them when they have ended. */
export interface Interface {
	/** Asks for the run, in the caller's transaction. It starts once the routine's earlier runs end. */
	readonly queue: (run: RoutineRun) => Effect.Effect<void>;
	/** Tells the run's workflow that it has ended, once the caller's transaction commits. */
	readonly settled: (run: RoutineRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/RoutineRuns") {}

export const make = Effect.gen(function* () {
	const lanes = yield* Lanes.Service;
	const engine = yield* WorkflowEngine.WorkflowEngine;
	return Service.of({
		queue: (run) =>
			lanes
				.admit({ key: routineLane(run), workflow: Routine, payload: run, whenBusy: "queue" })
				.pipe(Effect.asVoid),
		settled: (run) =>
			afterCommit(
				signalSettled(run).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
			),
	});
});

export const layer = Layer.effect(Service, make);

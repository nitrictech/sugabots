import { Effect } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { turnSignals } from "./signals.ts";

/** Signals for cases whose turns are jobs; a workflow it signals is never there. */
export const turnSignalsForTests = turnSignals(
	Effect.runSync(
		Effect.service(WorkflowEngine.WorkflowEngine).pipe(Effect.provide(WorkflowEngine.layerMemory)),
	),
);

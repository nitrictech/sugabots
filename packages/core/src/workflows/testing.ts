import { Effect, Layer, ManagedRuntime } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { Compaction } from "../conversations/compaction/compaction.workflow.ts";
import { Routine } from "../conversations/routines/routine.workflow.ts";
import { Summary } from "../conversations/summaries/summary.workflow.ts";
import { Facilitate } from "../conversations/turns/facilitate.workflow.ts";
import { Turn } from "../conversations/turns/turn.workflow.ts";
import { Lanes } from "./lanes.ts";

/**
 * A workflow engine for the Postgres cases. The workflows it starts only hold
 * their lanes: a case runs their steps itself, and frees each lane as the
 * workflow's last step would.
 */
const held = () => DurableDeferred.await(DurableDeferred.make("released"));

export const engineForTests = ManagedRuntime.make(
	Layer.mergeAll(
		Turn.toLayer(held),
		Facilitate.toLayer(held),
		Routine.toLayer(held),
		Summary.toLayer(held),
		Compaction.toLayer(held),
	).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
).runSync(Effect.service(WorkflowEngine.WorkflowEngine));

/** Lanes over the test engine, in the caller's database. */
export const lanesForTests = Lanes.make([Turn, Facilitate, Routine, Summary, Compaction]).pipe(
	Effect.provideService(WorkflowEngine.WorkflowEngine, engineForTests),
);

/** The test engine and lanes over it, as the services that start and signal workflows need them. */
export const workflowsForTests = Layer.merge(
	Layer.effect(Lanes.Service, lanesForTests),
	Layer.succeed(WorkflowEngine.WorkflowEngine, engineForTests),
);

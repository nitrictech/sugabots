export * as ChatWorkflows from "./workflows.ts";

import { Layer } from "effect";
import { Lanes } from "../workflows/lanes.ts";
import { automationWorkflow } from "./automations/automation.workflow.ts";
import { Automations } from "./automations/automations.ts";
import { compactionStepsLayer } from "./compaction/compaction.steps.ts";
import { compactionWorkflow } from "./compaction/compaction.workflow.ts";
import { Turns } from "./turns/turns.ts";

/** Every durable workflow: compactions, turns and automation runs. */
export const all = [compactionWorkflow, Turns.workflow, automationWorkflow] as const;

/** The definitions of the workflows in {@link all}. */
export const definitions = all.map((workflow) => workflow.definition);

/** The lanes the workflows in {@link all} run in. */
export const lanes = Lanes.layerFor(definitions);

/**
 * The workflows in {@link all}, run by the engine, each over its steps, and
 * the repair of lanes and turn cancels a crash left behind.
 */
export const layer = Layer.mergeAll(
	Lanes.reconcileLayer,
	Turns.cancelSweepLayer,
	...all.map((workflow) => workflow.layer),
).pipe(
	Layer.provide(Layer.mergeAll(compactionStepsLayer, Turns.stepsLayer, Automations.stepsLayer)),
);

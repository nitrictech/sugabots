export * as ChatWorkflows from "./workflows.ts";

import { Layer } from "effect";
import { Lanes } from "../workflows/lanes.ts";
import { automationWorkflow } from "./automations/automation.workflow.ts";
import { Automations } from "./automations/automations.ts";
import { compactionStepsLayer } from "./compaction/compaction.steps.ts";
import { compactionWorkflow } from "./compaction/compaction.workflow.ts";
import { Turns } from "./turns/turns.ts";

/**
 * Core's durable workflows: compactions and automation runs. A turn's
 * workflow is the bot loop's, which the server runs beside these.
 */
export const all = [compactionWorkflow, automationWorkflow] as const;

/** The definitions of the workflows in {@link all}. */
export const definitions = all.map((workflow) => workflow.definition);

/**
 * The workflows in {@link all}, run by the engine, each over its steps, and
 * the repair of lanes and turn cancels a crash left behind.
 */
export const layer = Layer.mergeAll(
	Lanes.reconcileLayer,
	Turns.cancelSweepLayer,
	...all.map((workflow) => workflow.layer),
).pipe(Layer.provide(Layer.mergeAll(compactionStepsLayer, Automations.stepsLayer)));

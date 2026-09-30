export * as ConversationWorkflows from "./workflows.ts";

import { Layer } from "effect";
import { Lanes } from "../workflows/lanes.ts";
import { compactionStepsLayer } from "./compaction/compaction.steps.ts";
import { compactionWorkflow } from "./compaction/compaction.workflow.ts";
import { facilitateWorkflow } from "./floor/facilitate.workflow.ts";
import { facilitateStepsLayer } from "./floor/facilitator.ts";
import { routineWorkflow } from "./routines/routine.workflow.ts";
import { Routines } from "./routines/routines.ts";
import { summaryStepsLayer } from "./summaries/summary.steps.ts";
import { summaryWorkflow } from "./summaries/summary.workflow.ts";
import { Turns } from "./turns/turns.ts";

/** Every durable workflow: summaries, compactions, turns, facilitation and routine runs. */
export const all = [
	summaryWorkflow,
	compactionWorkflow,
	Turns.workflow,
	facilitateWorkflow,
	routineWorkflow,
] as const;

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
	Layer.provide(
		Layer.mergeAll(
			summaryStepsLayer,
			compactionStepsLayer,
			Turns.stepsLayer,
			facilitateStepsLayer,
			Routines.stepsLayer,
		),
	),
);

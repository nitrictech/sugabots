export * as ConversationWorkflows from "./workflows.ts";

import { Layer } from "effect";
import { Lanes } from "../workflows/lanes.ts";
import { compactionStepsLayer } from "./compaction/compaction.steps.ts";
import { compactionWorkflow } from "./compaction/compaction.workflow.ts";
import { routineWorkflow } from "./routines/routine.workflow.ts";
import { routineStepsLayer } from "./routines/steps.ts";
import { summaryStepsLayer } from "./summaries/summary.steps.ts";
import { summaryWorkflow } from "./summaries/summary.workflow.ts";
import { facilitateWorkflow } from "./turns/facilitate.workflow.ts";
import { facilitateStepsLayer } from "./turns/facilitator.ts";
import { turnStepsLayer } from "./turns/turn.steps.ts";
import { turnWorkflow } from "./turns/turn.workflow.ts";

/** Every durable workflow: summaries, compactions, turns, facilitation and routine runs. */
export const all = [
	summaryWorkflow,
	compactionWorkflow,
	turnWorkflow,
	facilitateWorkflow,
	routineWorkflow,
] as const;

/** The definitions of the workflows in {@link all}. */
export const definitions = all.map((workflow) => workflow.definition);

/** The lanes the workflows in {@link all} run in. */
export const lanes = Lanes.layerFor(definitions);

/**
 * The workflows in {@link all}, run by the engine, each over its steps, and
 * the repair of lanes a crash left behind.
 */
export const layer = Layer.mergeAll(
	Lanes.reconcileLayer,
	...all.map((workflow) => workflow.layer),
).pipe(
	Layer.provide(
		Layer.mergeAll(
			summaryStepsLayer,
			compactionStepsLayer,
			turnStepsLayer,
			facilitateStepsLayer,
			routineStepsLayer,
		),
	),
);

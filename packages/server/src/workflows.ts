export * as Workflows from "./workflows.ts";

import { stepsLayer as compactionSteps } from "@sugabots/core/conversations/compaction/compaction.steps";
import {
	Compaction,
	compactionWorkflow,
} from "@sugabots/core/conversations/compaction/compaction.workflow";
import { Routine, routineWorkflow } from "@sugabots/core/conversations/routines/routine.workflow";
import { stepsLayer as routineSteps } from "@sugabots/core/conversations/routines/steps";
import { stepsLayer as summarySteps } from "@sugabots/core/conversations/summaries/summary.steps";
import { Summary, summaryWorkflow } from "@sugabots/core/conversations/summaries/summary.workflow";
import {
	Facilitate,
	facilitateWorkflow,
} from "@sugabots/core/conversations/turns/facilitate.workflow";
import { stepsLayer as facilitateSteps } from "@sugabots/core/conversations/turns/facilitator";
import { stepsLayer as turnSteps } from "@sugabots/core/conversations/turns/turn.steps";
import { Turn, turnWorkflow } from "@sugabots/core/conversations/turns/turn.workflow";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { WorkflowEngines } from "@sugabots/workflow/engine";
import { Config, Effect, Layer } from "effect";

/**
 * Which engine runs workflows, from `WORKFLOW_ENGINE`:
 * - `single-runner` (the default): embedded in this server, on its Postgres.
 *   One server process only.
 * - `memory`: nothing survives. For tests.
 */
const kind = Config.Literals(["single-runner", "memory"], "WORKFLOW_ENGINE").pipe(
	Config.withDefault("single-runner"),
);

export const engine = Layer.unwrap(
	Effect.gen(function* () {
		switch (yield* kind) {
			case "memory":
				return WorkflowEngines.memory;
			case "single-runner":
				return WorkflowEngines.singleRunner;
		}
	}),
);

/** The lanes every durable workflow runs in, on the engine. */
export const lanes = Lanes.layer([Summary, Compaction, Turn, Facilitate, Routine]);

/**
 * The workflows, run by the engine: summaries, compactions, turns,
 * facilitation and routine runs, each over its steps, and the repair of lanes
 * a crash left behind.
 */
export const layer = Layer.mergeAll(
	summaryWorkflow.layer,
	compactionWorkflow.layer,
	turnWorkflow.layer,
	facilitateWorkflow.layer,
	routineWorkflow.layer,
	Lanes.reconcileLayer,
).pipe(
	Layer.provide(
		Layer.mergeAll(summarySteps, compactionSteps, routineSteps, facilitateSteps, turnSteps),
	),
);

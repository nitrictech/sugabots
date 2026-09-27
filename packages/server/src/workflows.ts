export * as Workflows from "./workflows.ts";

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

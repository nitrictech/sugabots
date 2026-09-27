export * as WorkflowEngines from "./engine.ts";

import { NodeCrypto } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";

/**
 * The engines a workflow can run on. Workflow code depends only on Effect's
 * workflow API, so which of these runs it is configuration.
 *
 * - `memory` keeps everything in the process and survives nothing. For tests.
 * - `single-runner` is Effect's cluster engine inside this process, durable in
 *   the app's Postgres. It assumes it is the only process running the engine.
 */
export type Kind = "memory" | "single-runner";

export const memory: Layer.Layer<WorkflowEngine.WorkflowEngine> = WorkflowEngine.layerMemory;

/** Durable in the database behind the `SqlClient` it is given, which should be the app's. */
export const singleRunner = ClusterWorkflowEngine.layer.pipe(
	Layer.provide(SingleRunner.layer({ runnerStorage: "sql" })),
	Layer.provide(NodeCrypto.layer),
);

/** The engine named by `WORKFLOW_ENGINE`, `single-runner` by default. */
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const kind = yield* Config.String("WORKFLOW_ENGINE").pipe(Config.withDefault("single-runner"));
		if (kind === "memory") return memory;
		if (kind === "single-runner") return singleRunner;
		return yield* Effect.die(new Error(`Unknown WORKFLOW_ENGINE "${kind}"`));
	}),
);

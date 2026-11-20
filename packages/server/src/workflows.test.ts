import { noDatabaseClient } from "@sugabots/core/database/testing";
import { ConfigProvider, Effect, Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { Workflows } from "./workflows.ts";

const withEnv = (env: Record<string, string>) =>
	Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

// The single runner's layer uses the database as it is built, and fails on this one.
const engineFor = (env: Record<string, string>) =>
	Workflows.engine.pipe(withEnv(env), Layer.provide(noDatabaseClient));

describe("choosing the workflow engine", () => {
	it("builds the in-memory engine, which needs no database, when WORKFLOW_ENGINE names it", async () => {
		const engine = await Effect.runPromise(
			Effect.service(WorkflowEngine.WorkflowEngine).pipe(
				Effect.provide(engineFor({ WORKFLOW_ENGINE: "memory" })),
			),
		);

		expect(engine).toBeDefined();
	});

	it("refuses an engine it does not know", async () => {
		await expect(
			Effect.runPromise(Effect.scoped(Layer.build(engineFor({ WORKFLOW_ENGINE: "celery" })))),
		).rejects.toThrow(/WORKFLOW_ENGINE/);
	});
});

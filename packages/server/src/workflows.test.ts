import { clientLayer } from "@sugabots/core/database/database";
import { ConfigProvider, Effect, Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { Workflows } from "./workflows.ts";

// The single runner needs the app's Postgres, so every engine's layer asks for it.
const database = Layer.provide(clientLayer);

const withEnv = (env: Record<string, string>) =>
	Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe.skipIf(!process.env.DATABASE_URL)("choosing the workflow engine", () => {
	it("builds the engine WORKFLOW_ENGINE names", async () => {
		const engine = await Effect.runPromise(
			Effect.service(WorkflowEngine.WorkflowEngine).pipe(
				Effect.provide(Workflows.engine.pipe(withEnv({ WORKFLOW_ENGINE: "memory" }), database)),
			),
		);

		expect(engine).toBeDefined();
	});

	it("refuses an engine it does not know", async () => {
		await expect(
			Effect.runPromise(
				Effect.scoped(
					Layer.build(Workflows.engine.pipe(withEnv({ WORKFLOW_ENGINE: "celery" }), database)),
				),
			),
		).rejects.toThrow(/WORKFLOW_ENGINE/);
	});
});

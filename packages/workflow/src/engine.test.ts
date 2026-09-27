import { PgClient } from "@effect/sql-pg";
import { Config, Duration, Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { conformance } from "./conformance.ts";
import { WorkflowEngines } from "./engine.ts";

describe("the memory engine", () => {
	conformance({ engine: () => WorkflowEngines.memory, durable: false });
});

describe.skipIf(!process.env.DATABASE_URL)("the single-runner engine", () => {
	const singleRunner = () =>
		WorkflowEngines.singleRunner.pipe(
			Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
		);

	conformance({ engine: singleRunner, durable: true });

	it("refuses to start while another process runs it", async () => {
		await using first = ManagedRuntime.make(singleRunner());
		await first.runPromise(Effect.void);

		await using second = ManagedRuntime.make(
			WorkflowEngines.singleRunnerWith({ hostLockWait: Duration.seconds(2) }).pipe(
				Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
			),
		);
		await expect(second.runPromise(Effect.void)).rejects.toThrow(
			/Another process is already running/,
		);
	});
});

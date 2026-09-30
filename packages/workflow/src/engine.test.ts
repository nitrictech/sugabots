import { PgClient } from "@effect/sql-pg";
import { Config, Duration, Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DurableDeferred } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { conformance, Go, goToken, Suspending, start } from "./conformance.ts";
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

	it("drops a signal sent in a transaction that rolls back, with the locks on their own sessions", async () => {
		const url = Config.Redacted("DATABASE_URL");
		await using harness = start(
			WorkflowEngines.singleRunnerWith({
				hostLockWait: Duration.seconds(30),
				sessions: PgClient.layerConfig({ url }),
			}).pipe(Layer.provideMerge(PgClient.layerConfig({ url }))),
		);
		const executionId = await harness.run(
			Suspending.execute({ key: crypto.randomUUID() }, { discard: true }),
		);
		await harness.untilSuspended(executionId);
		const token = goToken(executionId);

		await harness.run(
			Effect.flatMap(SqlClient.SqlClient, (sql) =>
				sql.withTransaction(
					Effect.andThen(
						DurableDeferred.succeed(Go, { token, value: "rolled back" }),
						Effect.fail("undo"),
					),
				),
			).pipe(Effect.ignore),
		);
		await harness.run(DurableDeferred.succeed(Go, { token, value: "kept" }));

		expect(await harness.result(executionId)).toBe("before:kept:after");
	});
});

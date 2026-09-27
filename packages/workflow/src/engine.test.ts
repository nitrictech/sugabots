import { PgClient } from "@effect/sql-pg";
import { Config, Layer } from "effect";
import { describe } from "vitest";
import { conformance } from "./conformance.ts";
import { WorkflowEngines } from "./engine.ts";

describe("the memory engine", () => {
	conformance({ engine: () => WorkflowEngines.memory, durable: false });
});

describe.skipIf(!process.env.DATABASE_URL)("the single-runner engine", () => {
	conformance({
		engine: () =>
			WorkflowEngines.singleRunner.pipe(
				Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
			),
		durable: true,
	});
});

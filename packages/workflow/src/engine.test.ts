import { PgClient } from "@effect/sql-pg";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { Activity, Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { WorkflowEngines } from "./engine.ts";

class Greetings extends Context.Service<
	Greetings,
	{ readonly greet: (name: string) => Effect.Effect<string> }
>()("test/Greetings") {}

const Greet = Workflow.make("test/greet", {
	payload: { name: Schema.String },
	success: Schema.String,
	idempotencyKey: (payload) => payload.name,
});

// The activity depends only on the payload and its own name, and reaches its
// behaviour through a service, as every activity must.
const GreetLive = Greet.toLayer(({ name }) =>
	Activity.make({
		name: "greet",
		success: Schema.String,
		execute: Effect.gen(function* () {
			const greetings = yield* Greetings;
			return yield* greetings.greet(name);
		}),
	}),
);

const greetings = Layer.succeed(Greetings, { greet: (name) => Effect.succeed(`Hello, ${name}`) });

const runOn = <E>(engine: Layer.Layer<WorkflowEngine.WorkflowEngine, E>) =>
	Effect.gen(function* () {
		const name = `Ada ${crypto.randomUUID()}`;
		return { name, reply: yield* Greet.execute({ name }) };
	}).pipe(Effect.provide(GreetLive.pipe(Layer.provideMerge(engine), Layer.provide(greetings))));

describe("the workflow engines", () => {
	it("runs a workflow in memory", async () => {
		const { name, reply } = await Effect.runPromise(runOn(WorkflowEngines.memory));
		expect(reply).toBe(`Hello, ${name}`);
	});

	it.skipIf(!process.env.DATABASE_URL)("runs a workflow on the single runner", async () => {
		const database = PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") });
		const { name, reply } = await Effect.runPromise(
			runOn(WorkflowEngines.singleRunner.pipe(Layer.provide(database))).pipe(Effect.scoped),
		);
		expect(reply).toBe(`Hello, ${name}`);
	});
});

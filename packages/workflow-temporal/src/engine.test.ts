import { fileURLToPath } from "node:url";
import { conformance, probe } from "@sugabots/workflow/conformance";
import { registrations } from "@sugabots/workflow/conformance.workflow";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe } from "vitest";
import { makeActivities } from "./activities.ts";
import { layer, Temporal } from "./engine.ts";

const taskQueue = "conformance";
let environment: TestWorkflowEnvironment | undefined;
let stopWorker: (() => Promise<void>) | undefined;

// Temporal's test server, which the SDK downloads on first use.
beforeAll(async () => {
	environment = await TestWorkflowEnvironment.createLocal();
	const worker = await Worker.create({
		connection: environment.nativeConnection,
		namespace: environment.namespace ?? "default",
		taskQueue,
		workflowsPath: fileURLToPath(new URL("./testing/conformance.workflows.ts", import.meta.url)),
		activities: makeActivities(registrations, ManagedRuntime.make(probe)),
	});
	const running = worker.run();
	stopWorker = async () => {
		worker.shutdown();
		await running;
	};
}, 300_000);

afterAll(async () => {
	await stopWorker?.();
	await environment?.teardown();
}, 60_000);

describe("the Temporal engine", () => {
	conformance({
		engine: () => {
			if (!environment) throw new Error("Temporal's test server did not start");
			return layer.pipe(
				Layer.provide(Layer.succeed(Temporal, { client: environment.client, taskQueue })),
			);
		},
		durable: true,
	});
});

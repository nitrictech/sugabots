import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Lanes } from "../../workflows/lanes.ts";
import {
	Automation,
	type AutomationRun,
	AutomationSteps,
	automationLane,
	automationWorkflow,
	type StoredRun,
	signalSettled,
	storedRun,
} from "./automation.workflow.ts";

const start = vi.fn((_run: StoredRun) => Effect.void);
const settle = vi.fn((_run: StoredRun) => Effect.succeed(false));
const fail = vi.fn((_run: StoredRun) => Effect.void);
const release = vi.fn((_execution: { key: string; executionId: string }) => Effect.void);

const runtime = ManagedRuntime.make(
	automationWorkflow.layer.pipe(
		Layer.provideMerge(Layer.succeed(AutomationSteps, AutomationSteps.of({ start, settle, fail }))),
		Layer.provideMerge(
			Layer.succeed(
				Lanes.Service,
				Lanes.Service.of({
					admit: () => Effect.die("unused"),
					release,
					dropWaiting: () => Effect.die("unused"),
					reconcile: Effect.void,
				}),
			),
		),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(TestClock.layer()),
	),
);

afterAll(() => runtime.dispose());

const run = (): AutomationRun => ({
	automationId: crypto.randomUUID(),
	runId: crypto.randomUUID(),
});

/** Starts the run's workflow, returning its execution id. */
const execute = (asked: AutomationRun) =>
	runtime.runPromise(Automation.execute(storedRun(asked), { discard: true }));

describe("the automation workflow", () => {
	beforeEach(() => {
		for (const step of [start, settle, fail, release]) step.mockClear();
	});

	it("starts the run, waits until it is settled, then frees the lane", async () => {
		const asked = run();
		const executionId = await execute(asked);
		await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
		expect(start).toHaveBeenCalledOnce();
		expect(release).not.toHaveBeenCalled();

		settle.mockReturnValueOnce(Effect.succeed(true));
		await runtime.runPromise(signalSettled(asked));

		await vi.waitFor(() =>
			expect(release).toHaveBeenCalledWith({ key: automationLane(asked), executionId }),
		);
		expect(settle).toHaveBeenCalledTimes(2);
	});

	it("checks again each minute for a settlement whose signal was lost", async () => {
		const asked = run();
		await execute(asked);
		await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));

		await vi.waitFor(async () => {
			await runtime.runPromise(TestClock.adjust(Duration.minutes(1)));
			expect(settle).toHaveBeenCalledTimes(2);
		});

		settle.mockReturnValueOnce(Effect.succeed(true));
		await vi.waitFor(async () => {
			await runtime.runPromise(TestClock.adjust(Duration.minutes(1)));
			expect(release).toHaveBeenCalled();
		});
		expect(settle).toHaveBeenCalledTimes(3);
	});

	it("frees the lane at once for a run that has already ended", async () => {
		settle.mockReturnValueOnce(Effect.succeed(true));
		const asked = run();

		const executionId = await execute(asked);

		await vi.waitFor(() =>
			expect(release).toHaveBeenCalledWith({ key: automationLane(asked), executionId }),
		);
		expect(settle).toHaveBeenCalledOnce();
		expect(fail).not.toHaveBeenCalled();
	});

	it("records the run as failed before freeing the lane when starting it dies", async () => {
		const order: string[] = [];
		start.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		fail.mockImplementationOnce(() => Effect.sync(() => void order.push("fail")));
		release.mockImplementationOnce(() => Effect.sync(() => void order.push("release")));
		const asked = run();

		await execute(asked);

		await vi.waitFor(() => expect(order).toEqual(["fail", "release"]));
		expect(fail).toHaveBeenCalledWith(storedRun(asked));
		expect(settle).not.toHaveBeenCalled();
	});
});

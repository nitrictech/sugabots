import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Routine,
	type RoutineRun,
	RoutineSteps,
	routineWorkflow,
	signalSettled,
} from "./routine.workflow.ts";

const start = vi.fn((_run: RoutineRun) => Effect.void);
const settle = vi.fn((_run: RoutineRun) => Effect.succeed(false));
const release = vi.fn((_run: RoutineRun) => Effect.void);

const runtime = ManagedRuntime.make(
	Routine.toLayer(routineWorkflow).pipe(
		Layer.provideMerge(Layer.succeed(RoutineSteps, RoutineSteps.of({ start, settle, release }))),
		Layer.provideMerge(WorkflowEngine.layerMemory),
	),
);

afterAll(() => runtime.dispose());

const run = (): RoutineRun => ({
	routineId: crypto.randomUUID(),
	executionId: crypto.randomUUID(),
});

describe("the routine workflow", () => {
	beforeEach(() => {
		for (const step of [start, settle, release]) step.mockClear();
	});

	it("starts the run, waits until it is settled, then frees the lane", async () => {
		const asked = run();
		await runtime.runPromise(Routine.execute(asked, { discard: true }));
		await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
		expect(start).toHaveBeenCalledOnce();
		expect(release).not.toHaveBeenCalled();

		settle.mockReturnValueOnce(Effect.succeed(true));
		await runtime.runPromise(signalSettled(asked));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(settle).toHaveBeenCalledTimes(2);
	});

	it("frees the lane at once for a run that has already ended", async () => {
		settle.mockReturnValueOnce(Effect.succeed(true));
		const asked = run();

		await runtime.runPromise(Routine.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(settle).toHaveBeenCalledOnce();
	});

	it("frees the lane when starting the run dies", async () => {
		start.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		const asked = run();

		await runtime.runPromise(Routine.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(settle).not.toHaveBeenCalled();
	});
});

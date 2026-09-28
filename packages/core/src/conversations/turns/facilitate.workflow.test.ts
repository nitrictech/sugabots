import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Lanes } from "../../workflows/lanes.ts";
import {
	type AttemptOutcome,
	Facilitate,
	type FacilitateRequest,
	FacilitateSteps,
	facilitateLane,
	facilitateWorkflow,
} from "./facilitate.workflow.ts";

const attempt = vi.fn((_request: FacilitateRequest, _attempt: number) =>
	Effect.succeed<AttemptOutcome>("decided"),
);
const abandon = vi.fn((_request: FacilitateRequest) => Effect.void);
const announceReleased = vi.fn((_request: FacilitateRequest) => Effect.void);
const release = vi.fn((_execution: { key: string; executionId: string }) => Effect.void);

const runtime = ManagedRuntime.make(
	facilitateWorkflow.layer.pipe(
		Layer.provideMerge(
			Layer.succeed(FacilitateSteps, FacilitateSteps.of({ attempt, abandon, announceReleased })),
		),
		Layer.provideMerge(
			Layer.succeed(
				Lanes.Service,
				Lanes.Service.of({ admit: () => Effect.die("unused"), release, reconcile: Effect.void }),
			),
		),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(TestClock.layer()),
	),
);

afterAll(() => runtime.dispose());

const request = (): FacilitateRequest => ({
	threadId: crypto.randomUUID(),
	triggerMessageId: crypto.randomUUID(),
});

/** Moves time on until `check` passes, for as long as the workflow waits out retry delays. */
const passingTime = (check: () => void) =>
	vi.waitFor(async () => {
		await runtime.runPromise(TestClock.adjust(Duration.seconds(1)));
		check();
	});

describe("the facilitate workflow", () => {
	beforeEach(() => {
		for (const step of [attempt, abandon, announceReleased, release]) step.mockClear();
	});

	it("runs a failed attempt again after a delay, then frees the lane", async () => {
		attempt.mockReturnValueOnce(Effect.succeed("failed"));
		const asked = request();

		const executionId = await runtime.runPromise(Facilitate.execute(asked, { discard: true }));

		await passingTime(() =>
			expect(release).toHaveBeenCalledWith({ key: facilitateLane(asked), executionId }),
		);
		expect(attempt.mock.calls.map(([, number]) => number)).toEqual([1, 2]);
		expect(announceReleased).toHaveBeenCalledWith(asked);
		expect(abandon).not.toHaveBeenCalled();
	});

	it("fails after the third failed attempt, settling the routine before freeing the lane", async () => {
		const order: string[] = [];
		for (let failure = 0; failure < 3; failure++)
			attempt.mockReturnValueOnce(Effect.succeed("failed"));
		abandon.mockImplementationOnce(() => Effect.sync(() => void order.push("abandon")));
		release.mockImplementationOnce(() => Effect.sync(() => void order.push("release")));
		const asked = request();

		await runtime.runPromise(Facilitate.execute(asked, { discard: true }));

		await passingTime(() => expect(release).toHaveBeenCalled());
		expect(attempt.mock.calls.map(([, number]) => number)).toEqual([1, 2, 3]);
		expect(order).toEqual(["abandon", "release"]);
		expect(abandon).toHaveBeenCalledWith(asked);
	});

	it("settles and frees the lane when an attempt dies", async () => {
		attempt.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		const asked = request();

		const executionId = await runtime.runPromise(Facilitate.execute(asked, { discard: true }));

		await vi.waitFor(() =>
			expect(release).toHaveBeenCalledWith({ key: facilitateLane(asked), executionId }),
		);
		expect(abandon).toHaveBeenCalledWith(asked);
	});
});

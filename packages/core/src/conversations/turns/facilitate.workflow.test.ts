import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AttemptOutcome,
	Facilitate,
	type FacilitateRequest,
	FacilitateSteps,
	facilitate,
} from "./facilitate.workflow.ts";

const attempt = vi.fn((_request: FacilitateRequest, _attempt: number) =>
	Effect.succeed<AttemptOutcome>("finished"),
);
const abandon = vi.fn((_request: FacilitateRequest) => Effect.void);
const release = vi.fn((_request: FacilitateRequest) => Effect.void);

const runtime = ManagedRuntime.make(
	Facilitate.toLayer(facilitate).pipe(
		Layer.provideMerge(
			Layer.succeed(FacilitateSteps, FacilitateSteps.of({ attempt, abandon, release })),
		),
		Layer.provideMerge(WorkflowEngine.layerMemory),
	),
);

afterAll(() => runtime.dispose());

const request = (): FacilitateRequest => ({
	threadId: crypto.randomUUID(),
	triggerMessageId: crypto.randomUUID(),
});

describe("the facilitate workflow", () => {
	beforeEach(() => {
		for (const step of [attempt, abandon, release]) step.mockClear();
	});

	it("runs a failed attempt again, then frees the lane", async () => {
		attempt.mockReturnValueOnce(Effect.succeed("retry"));
		const asked = request();

		await runtime.runPromise(Facilitate.execute(asked, { discard: true }));

		// The retry waits out its backoff first.
		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked), { timeout: 3_000 });
		expect(attempt.mock.calls.map(([, number]) => number)).toEqual([1, 2]);
		expect(abandon).not.toHaveBeenCalled();
	});

	it("settles and frees the lane when an attempt dies", async () => {
		attempt.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		const asked = request();

		await runtime.runPromise(Facilitate.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(abandon).toHaveBeenCalledWith(asked);
	});
});

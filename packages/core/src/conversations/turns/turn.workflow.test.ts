import { Effect, Layer, ManagedRuntime } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	approvalsDecided,
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turn,
} from "./turn.workflow.ts";

const segment = vi.fn((_request: TurnRequest, _attempt: number) =>
	Effect.succeed<SegmentOutcome>({ _tag: "Finished" }),
);
const abandon = vi.fn((_request: TurnRequest) => Effect.void);
const release = vi.fn((_request: TurnRequest) => Effect.void);

const runtime = ManagedRuntime.make(
	Turn.toLayer(turn).pipe(
		Layer.provideMerge(Layer.succeed(TurnSteps, TurnSteps.of({ segment, abandon, release }))),
		Layer.provideMerge(WorkflowEngine.layerMemory),
	),
);

afterAll(() => runtime.dispose());

const request = (): TurnRequest => ({
	threadId: crypto.randomUUID(),
	agentId: crypto.randomUUID(),
	triggerMessageId: crypto.randomUUID(),
	reason: "mention",
});

describe("the turn workflow", () => {
	beforeEach(() => {
		segment.mockClear();
		abandon.mockClear();
		release.mockClear();
	});

	it("waits for approvals between segments and retries a failed run", async () => {
		segment
			.mockReturnValueOnce(Effect.succeed({ _tag: "Retry" }))
			.mockReturnValueOnce(Effect.succeed({ _tag: "Suspended", approvals: "approval-1" }));
		const asked = request();

		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		// The retry waits out its backoff first.
		await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(2), { timeout: 3_000 });
		expect(release).not.toHaveBeenCalled();

		const decided = approvalsDecided("approval-1");
		await runtime.runPromise(
			DurableDeferred.succeed(decided, {
				token: DurableDeferred.tokenFromExecutionId(decided, { workflow: Turn, executionId }),
				value: undefined,
			}),
		);

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		// The run after a suspension is the same attempt; only failures count.
		expect(segment.mock.calls.map(([, attempt]) => attempt)).toEqual([1, 2, 2]);
		expect(abandon).not.toHaveBeenCalled();
	});

	it("ends the turn and frees its lane when a segment dies", async () => {
		segment.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		const asked = request();

		await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(abandon).toHaveBeenCalledWith(asked);
	});
});

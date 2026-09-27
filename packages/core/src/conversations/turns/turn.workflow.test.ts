import { Effect, Layer, ManagedRuntime } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { turnSignals } from "./signals.ts";
import {
	type ApprovalDecision,
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnWorkflow,
} from "./turn.workflow.ts";

const segment = vi.fn((_request: TurnRequest, _attempt: number) =>
	Effect.succeed<SegmentOutcome>({ _tag: "Finished" }),
);
const decide = vi.fn(
	(_request: TurnRequest, _approvalId: string, _decision: ApprovalDecision) => Effect.void,
);
const stopWaiting = vi.fn((_request: TurnRequest) => Effect.void);
const abandon = vi.fn((_request: TurnRequest) => Effect.void);
const release = vi.fn((_request: TurnRequest) => Effect.void);

const runtime = ManagedRuntime.make(
	Turn.toLayer(turnWorkflow).pipe(
		Layer.provideMerge(
			Layer.succeed(TurnSteps, TurnSteps.of({ segment, decide, stopWaiting, abandon, release })),
		),
		Layer.provideMerge(WorkflowEngine.layerMemory),
	),
);
const signals = turnSignals(
	await runtime.runPromise(Effect.service(WorkflowEngine.WorkflowEngine)),
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
		for (const step of [segment, decide, stopWaiting, abandon, release]) step.mockClear();
	});

	it("records each decision as it arrives, then runs on, retrying a failed run", async () => {
		segment
			.mockReturnValueOnce(Effect.succeed({ _tag: "Retry" }))
			.mockReturnValueOnce(Effect.succeed({ _tag: "Suspended", approvals: ["first", "second"] }));
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		// The retry waits out its backoff first.
		await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(2), { timeout: 3_000 });

		// The second approval is decided first, and recorded while the first still waits.
		const second = { decision: "deny", userId: "sam" } as const;
		await runtime.runPromise(
			signals.decide({ owner: executionId, approvalId: "second", decision: second }),
		);
		await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(asked, "second", second));
		expect(segment).toHaveBeenCalledTimes(2);

		const first = { decision: "allow_once", userId: "alex" } as const;
		await runtime.runPromise(
			signals.decide({ owner: executionId, approvalId: "first", decision: first }),
		);

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(decide.mock.calls.map(([, approvalId]) => approvalId)).toEqual(["second", "first"]);
		// The run after a suspension is the same attempt; only failures count.
		expect(segment.mock.calls.map(([, attempt]) => attempt)).toEqual([1, 2, 2]);
		expect(abandon).not.toHaveBeenCalled();
	});

	it("records a cancel and ends while waiting", async () => {
		segment.mockReturnValueOnce(Effect.succeed({ _tag: "Suspended", approvals: ["only"] }));
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(1));

		await runtime.runPromise(signals.cancel(executionId));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(stopWaiting).toHaveBeenCalledWith(asked);
		expect(decide).not.toHaveBeenCalled();
		expect(segment).toHaveBeenCalledTimes(1);
	});

	it("ends the turn and frees its lane when a segment dies", async () => {
		segment.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		const asked = request();

		await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(release).toHaveBeenCalledWith(asked));
		expect(abandon).toHaveBeenCalledWith(asked);
	});
});

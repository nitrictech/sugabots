import { Duration, Effect, Layer, ManagedRuntime, Option } from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Lanes } from "../../workflows/lanes.ts";
import type { DecidedApproval } from "../tools/calls/lifecycle.ts";
import { TurnSignals } from "./signals.ts";
import {
	type SegmentOutcome,
	Turn,
	type TurnRequest,
	TurnSteps,
	turnLane,
	turnWorkflow,
} from "./turn.workflow.ts";

const segment = vi.fn((_request: TurnRequest) =>
	Effect.succeed<SegmentOutcome>({ _tag: "Finished" }),
);
const decide = vi.fn((_request: TurnRequest, _decided: DecidedApproval) => Effect.void);
const stopWaiting = vi.fn((_request: TurnRequest) => Effect.void);
const abandon = vi.fn((_request: TurnRequest) => Effect.void);
const settleRoutine = vi.fn((_request: TurnRequest) => Effect.void);
const release = vi.fn((_execution: { key: string; executionId: string }) => Effect.void);

const runtime = ManagedRuntime.make(
	turnWorkflow.layer.pipe(
		Layer.provideMerge(
			Layer.succeed(
				TurnSteps,
				TurnSteps.of({ segment, decide, stopWaiting, abandon, settleRoutine }),
			),
		),
		Layer.provideMerge(
			Layer.succeed(
				Lanes.Service,
				Lanes.Service.of({
					admit: () => Effect.die("unused"),
					release,
					reconcile: Effect.void,
				}),
			),
		),
		Layer.provideMerge(WorkflowEngine.layerMemory),
		Layer.provideMerge(TestClock.layer()),
	),
);
const signals = await runtime.runPromise(TurnSignals.make);

afterAll(() => runtime.dispose());

const request = (): TurnRequest => ({
	threadId: crypto.randomUUID(),
	agentId: crypto.randomUUID(),
	triggerMessageId: crypto.randomUUID(),
	reason: "mention",
});

const untilSuspended = (executionId: string) =>
	vi.waitFor(async () => {
		const polled = await runtime.runPromise(Turn.poll(executionId));
		expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended");
	});

describe("the turn workflow", () => {
	beforeEach(() => {
		for (const step of [segment, decide, stopWaiting, abandon, settleRoutine, release]) {
			step.mockClear();
		}
	});

	it("runs a failed segment again once the retry delay has passed", async () => {
		segment.mockReturnValueOnce(Effect.succeed({ _tag: "Retry" }));
		const asked = request();

		await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await vi.waitFor(() => expect(segment).toHaveBeenCalledTimes(1));
		expect(segment).toHaveBeenCalledTimes(1);

		await vi.waitFor(async () => {
			await runtime.runPromise(TestClock.adjust(Duration.seconds(2)));
			expect(segment).toHaveBeenCalledTimes(2);
		});
		await vi.waitFor(() => expect(settleRoutine).toHaveBeenCalledWith(asked));
		expect(abandon).not.toHaveBeenCalled();
	});

	it("keeps the lane while waiting for approvals, and records each decision as it arrives", async () => {
		segment.mockReturnValueOnce(
			Effect.succeed({ _tag: "Suspended", approvals: ["first", "second"] }),
		);
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);
		expect(release).not.toHaveBeenCalled();
		expect(abandon).not.toHaveBeenCalled();

		// The second approval is decided first, and recorded while the first still waits.
		const second = { decision: "deny", userId: "sam" } as const;
		await runtime.runPromise(
			signals.decide({ owner: executionId, approvalId: "second", decision: second }),
		);
		await vi.waitFor(() =>
			expect(decide).toHaveBeenCalledWith(asked, { approvalId: "second", decision: second }),
		);
		await untilSuspended(executionId);
		expect(release).not.toHaveBeenCalled();

		const first = { decision: "allow_once", userId: "alex" } as const;
		await runtime.runPromise(
			signals.decide({ owner: executionId, approvalId: "first", decision: first }),
		);

		await vi.waitFor(() =>
			expect(release).toHaveBeenCalledWith({ key: turnLane(asked), executionId }),
		);
		expect(decide.mock.calls.map(([, decided]) => decided.approvalId)).toEqual(["second", "first"]);
		expect(segment).toHaveBeenCalledTimes(2);
		expect(settleRoutine).toHaveBeenCalledWith(asked);
	});

	it("records a cancel and ends while waiting", async () => {
		segment.mockReturnValueOnce(Effect.succeed({ _tag: "Suspended", approvals: ["only"] }));
		const asked = request();
		const executionId = await runtime.runPromise(Turn.execute(asked, { discard: true }));
		await untilSuspended(executionId);

		await runtime.runPromise(signals.cancel(executionId));

		await vi.waitFor(() =>
			expect(release).toHaveBeenCalledWith({ key: turnLane(asked), executionId }),
		);
		expect(stopWaiting).toHaveBeenCalledWith(asked);
		expect(decide).not.toHaveBeenCalled();
		expect(segment).toHaveBeenCalledTimes(1);
	});

	it("ends the turn before freeing its lane when a segment dies", async () => {
		const order: string[] = [];
		segment.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		abandon.mockImplementationOnce(() => Effect.sync(() => void order.push("abandon")));
		release.mockImplementationOnce(() => Effect.sync(() => void order.push("release")));
		const asked = request();

		await runtime.runPromise(Turn.execute(asked, { discard: true }));

		await vi.waitFor(() => expect(settleRoutine).toHaveBeenCalledWith(asked));
		expect(abandon).toHaveBeenCalledWith(asked);
		expect(order).toEqual(["abandon", "release"]);
	});
});

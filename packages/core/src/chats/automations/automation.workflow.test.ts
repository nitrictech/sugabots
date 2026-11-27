import { Clock, Duration, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/unstable/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lanes } from "../../workflows/lanes.ts";
import {
	Automation,
	type AutomationRun,
	AutomationSteps,
	automationLane,
	automationWorkflow,
	signalSettled,
} from "./automation.workflow.ts";

const start = vi.fn((_run: AutomationRun) => Effect.void);
const settle = vi.fn((_run: AutomationRun) => Effect.succeed(false));
const fail = vi.fn((_run: AutomationRun) => Effect.void);
const release = vi.fn((_execution: { key: string; executionId: string }) => Effect.void);

const makeRuntime = (sleepStarted: (duration: Duration.Duration) => void) =>
	ManagedRuntime.make(
		automationWorkflow.layer.pipe(
			Layer.provideMerge(
				Layer.succeed(AutomationSteps, AutomationSteps.of({ start, settle, fail })),
			),
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
			Layer.provideMerge(
				Layer.effect(
					Clock.Clock,
					Effect.gen(function* () {
						const clock = yield* TestClock.make();
						return {
							...clock,
							sleep: (duration: Duration.Duration) =>
								Effect.gen(function* () {
									const sleeping = yield* Effect.forkChild(clock.sleep(duration), {
										startImmediately: true,
									});
									yield* Effect.sync(() => sleepStarted(duration));
									yield* Fiber.join(sleeping);
								}),
						};
					}),
				),
			),
		),
	);

const run = (): AutomationRun => ({
	automationId: crypto.randomUUID(),
	runId: crypto.randomUUID(),
});

describe("the automation workflow", () => {
	let sleeping: PromiseWithResolvers<Duration.Duration>;
	let released: PromiseWithResolvers<void>;
	let runtime: ReturnType<typeof makeRuntime>;
	const execute = (asked: AutomationRun) =>
		runtime.runPromise(Automation.execute(asked, { discard: true }));

	beforeEach(() => {
		sleeping = Promise.withResolvers<Duration.Duration>();
		released = Promise.withResolvers<void>();
		runtime = makeRuntime((duration) => sleeping.resolve(duration));
		start.mockReset().mockReturnValue(Effect.void);
		settle.mockReset().mockReturnValue(Effect.succeed(false));
		fail.mockReset().mockReturnValue(Effect.void);
		release.mockReset().mockImplementation(() => Effect.sync(() => released.resolve()));
	});
	afterEach(() => runtime.dispose());

	it("starts the run, waits until it is settled, then frees the lane", async () => {
		const asked = run();
		const executionId = await execute(asked);
		await sleeping.promise;
		expect(settle).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledOnce();
		expect(release).not.toHaveBeenCalled();

		settle.mockReturnValueOnce(Effect.succeed(true));
		await runtime.runPromise(signalSettled(asked));

		await released.promise;
		expect(release).toHaveBeenCalledWith({ key: automationLane(asked), executionId });
		expect(settle).toHaveBeenCalledTimes(2);
	});

	it("checks again each minute for a settlement whose signal was lost", async () => {
		const asked = run();
		const interval = Duration.minutes(1);
		await execute(asked);
		expect(await sleeping.promise, "The next settlement check must be due in one minute").toEqual(
			interval,
		);
		expect(settle).toHaveBeenCalledOnce();

		sleeping = Promise.withResolvers<Duration.Duration>();
		await runtime.runPromise(TestClock.adjust(interval));
		expect(await sleeping.promise, "The next settlement check must be due in one minute").toEqual(
			interval,
		);
		expect(settle).toHaveBeenCalledTimes(2);

		settle.mockReturnValueOnce(Effect.succeed(true));
		await runtime.runPromise(TestClock.adjust(interval));
		await released.promise;
		expect(settle).toHaveBeenCalledTimes(3);
	});

	it("frees the lane at once for a run that has already ended", async () => {
		settle.mockReturnValueOnce(Effect.succeed(true));
		const asked = run();

		const executionId = await execute(asked);

		await released.promise;
		expect(release).toHaveBeenCalledWith({ key: automationLane(asked), executionId });
		expect(settle).toHaveBeenCalledOnce();
		expect(fail).not.toHaveBeenCalled();
	});

	it("records the run as failed before freeing the lane when starting it dies", async () => {
		const order: string[] = [];
		start.mockReturnValueOnce(Effect.die(new Error("database unavailable")));
		fail.mockImplementationOnce(() => Effect.sync(() => void order.push("fail")));
		release.mockImplementationOnce(() =>
			Effect.sync(() => {
				order.push("release");
				released.resolve();
			}),
		);
		const asked = run();

		await execute(asked);

		await released.promise;
		expect(order).toEqual(["fail", "release"]);
		expect(fail).toHaveBeenCalledWith(asked);
		expect(settle).not.toHaveBeenCalled();
	});
});

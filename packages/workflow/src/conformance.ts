import {
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Option,
	Schedule,
	Schema,
} from "effect";
import { Activity, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { expect, it } from "vitest";
import { Activities } from "./activities.ts";

/**
 * The behaviour every engine must share, so that swapping engines is only
 * configuration. Each engine's tests call `conformance` with a way to build
 * it; `durable` engines also prove an execution survives the engine stopping.
 *
 * Activities here follow the rule every workflow does: behaviour depends only
 * on the payload and the activity's name, reached through a service.
 */
export function conformance(options: {
	readonly engine: () => Layer.Layer<WorkflowEngine.WorkflowEngine, unknown>;
	readonly durable: boolean;
}) {
	it("memoises activities across a suspension", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();
		const executionId = await harness.run(Suspending.execute({ key }, { discard: true }));
		await harness.untilSuspended(executionId);
		await harness.run(DurableDeferred.succeed(Go, { token: goToken(executionId), value: "go" }));

		expect(await harness.result(executionId)).toBe("before:go:after");
		expect(runs(key)).toEqual(["before", "after"]);
	});

	it("keeps the first value sent to a deferred", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();
		const executionId = await harness.run(Suspending.execute({ key }, { discard: true }));
		await harness.untilSuspended(executionId);
		await harness.run(DurableDeferred.succeed(Go, { token: goToken(executionId), value: "first" }));
		await harness.run(
			DurableDeferred.succeed(Go, { token: goToken(executionId), value: "second" }),
		);

		expect(await harness.result(executionId)).toBe("before:first:after");
	});

	it("accepts a deferred for an execution that has finished", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();
		const executionId = await harness.run(Suspending.execute({ key }, { discard: true }));
		await harness.untilSuspended(executionId);
		await harness.run(DurableDeferred.succeed(Go, { token: goToken(executionId), value: "go" }));
		await harness.result(executionId);

		await harness.run(DurableDeferred.succeed(Go, { token: goToken(executionId), value: "late" }));
	});

	it("attaches a repeated start to the running execution", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();
		const first = await harness.run(Suspending.execute({ key }, { discard: true }));
		const second = await harness.run(Suspending.execute({ key }, { discard: true }));
		expect(second).toBe(first);
		await harness.untilSuspended(first);

		expect(runs(key)).toEqual(["before"]);
	});

	it("ends a suspended execution when interrupted", async () => {
		await using harness = start(options.engine());
		const executionId = await harness.run(
			Suspending.execute({ key: crypto.randomUUID() }, { discard: true }),
		);
		await harness.untilSuspended(executionId);
		await harness.run(Suspending.interrupt(executionId));

		const ended = await harness.completion(executionId);
		expect(Exit.hasInterrupts(ended)).toBe(true);
	});

	it("wakes for whichever of several deferreds completes first", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();
		const executionId = await harness.run(Racing.execute({ key }, { discard: true }));
		await harness.untilSuspended(executionId, Racing);

		// B before A: the execution records B while still waiting for A.
		await harness.run(
			DurableDeferred.succeed(Second, { token: racingToken(Second, executionId), value: "b" }),
		);
		await harness.until(() => runs(key).includes("second"));
		expect(runs(key)).toEqual(["second"]);

		await harness.run(
			DurableDeferred.succeed(First, { token: racingToken(First, executionId), value: "a" }),
		);
		expect(await harness.result(executionId, Racing)).toBe("second:b,first:a");
		expect(runs(key)).toEqual(["second", "first", "cleanup"]);
	});

	it.runIf(options.durable)("keeps a race's winner across an engine restart", async () => {
		const key = crypto.randomUUID();
		const executionId = await (async () => {
			await using harness = start(options.engine());
			const id = await harness.run(Racing.execute({ key }, { discard: true }));
			await harness.untilSuspended(id, Racing);
			await harness.run(
				DurableDeferred.succeed(Second, { token: racingToken(Second, id), value: "b" }),
			);
			await harness.until(() => runs(key).includes("second"));
			await harness.untilSuspended(id, Racing);
			return id;
		})();

		await using restarted = start(options.engine());
		await restarted.run(
			DurableDeferred.succeed(First, { token: racingToken(First, executionId), value: "a" }),
		);

		expect(await restarted.result(executionId, Racing)).toBe("second:b,first:a");
		expect(runs(key)).toEqual(["second", "first", "cleanup"]);
	});

	it("retries a failing activity within its budget", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();

		expect(await harness.run(Flaky.execute({ key, failures: 2 }))).toBe(3);
	});

	it.runIf(options.durable)("resumes an execution after the engine restarts", async () => {
		const key = crypto.randomUUID();
		const executionId = await (async () => {
			await using harness = start(options.engine());
			const id = await harness.run(Suspending.execute({ key }, { discard: true }));
			await harness.untilSuspended(id);
			return id;
		})();

		await using restarted = start(options.engine());
		await restarted.run(DurableDeferred.succeed(Go, { token: goToken(executionId), value: "go" }));

		expect(await restarted.result(executionId)).toBe("before:go:after");
		expect(runs(key)).toEqual(["before", "after"]);
	});
}

/** What each execution's activities did, shared across engine restarts in one test process. */
const recorded = new Map<string, string[]>();
const runs = (key: string) => recorded.get(key) ?? [];

class Probe extends Context.Service<
	Probe,
	{
		readonly record: (key: string, step: string) => Effect.Effect<void>;
		readonly attempt: (key: string, failures: number) => Effect.Effect<number, string>;
	}
>()("@sugabots/workflow/conformance/Probe") {}

const probe = Layer.succeed(Probe, {
	record: (key, step) =>
		Effect.sync(() => {
			recorded.set(key, [...runs(key), step]);
		}),
	attempt: (key, failures) =>
		Effect.suspend(() => {
			const attempts = [...runs(key), "attempt"];
			recorded.set(key, attempts);
			return attempts.length > failures
				? Effect.succeed(attempts.length)
				: Effect.fail(`attempt ${attempts.length} failed`);
		}),
});

const Go = DurableDeferred.make("go", { success: Schema.String });

const Suspending = Workflow.make("conformance/suspending", {
	payload: { key: Schema.String },
	success: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

const Flaky = Workflow.make("conformance/flaky", {
	payload: { key: Schema.String, failures: Schema.Finite },
	success: Schema.Finite,
	error: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

const Racing = Workflow.make("conformance/racing", {
	payload: { key: Schema.String },
	success: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

const First = DurableDeferred.make("first", { success: Schema.String });
const Second = DurableDeferred.make("second", { success: Schema.String });

const racingToken = (deferred: typeof First, executionId: string) =>
	DurableDeferred.tokenFromExecutionId(deferred, { workflow: Racing, executionId });

const goToken = (executionId: string) =>
	DurableDeferred.tokenFromExecutionId(Go, { workflow: Suspending, executionId });

/** The conformance workflows' activities, defined once so any engine can rebuild them by name. */
export const suspendingActivities = Activities.make<typeof Suspending.payloadSchema.Type>()({
	step: {
		execute: ({ key }, name) =>
			Effect.gen(function* () {
				const recorder = yield* Probe;
				yield* recorder.record(key, name);
			}),
	},
});

export const flakyActivities = Activities.make<typeof Flaky.payloadSchema.Type>()({
	flaky: {
		success: Schema.Finite,
		error: Schema.String,
		execute: ({ key, failures }) =>
			Effect.gen(function* () {
				const attempts = yield* Probe;
				return yield* attempts.attempt(key, failures);
			}),
	},
});

export const racingActivities = Activities.make<typeof Racing.payloadSchema.Type>()({
	step: {
		execute: ({ key }, name) =>
			Effect.gen(function* () {
				const recorder = yield* Probe;
				yield* recorder.record(key, name);
			}),
	},
});

/**
 * Waits for several deferreds by racing the ones still outstanding, so the
 * execution records each as it completes, in whatever order they arrive.
 */
const racing = (payload: typeof Racing.payloadSchema.Type) =>
	Effect.gen(function* () {
		// A suspension inside the race surfaces as an interruption the body can
		// catch; clean-up must run only once the execution has really ended.
		const ended = yield* Effect.exit(race(payload));
		const instance = yield* WorkflowEngine.WorkflowInstance;
		if (instance.suspended) return yield* ended;
		yield* racingActivities.activity("step", payload, "cleanup");
		return yield* ended;
	});

const race = (payload: typeof Racing.payloadSchema.Type) =>
	Effect.gen(function* () {
		const decided: string[] = [];
		let outstanding = [First, Second];
		for (let round = 0; outstanding.length > 0; round++) {
			const [first, ...rest] = outstanding.map((deferred) =>
				Effect.map(DurableDeferred.await(deferred), (value) => `${deferred.name}:${value}`),
			);
			const winner = yield* DurableDeferred.raceAll({
				name: `racing/${round}`,
				success: Schema.String,
				error: Schema.Never,
				effects: [first as Effect.Effect<string, never, never>, ...rest],
			});
			const name = winner.slice(0, winner.indexOf(":"));
			yield* racingActivities.activity("step", payload, name);
			decided.push(winner);
			outstanding = outstanding.filter((deferred) => deferred.name !== name);
		}
		return decided.join(",");
	});

const workflows = Layer.mergeAll(
	Racing.toLayer(racing),
	Suspending.toLayer((payload) =>
		Effect.gen(function* () {
			yield* suspendingActivities.activity("step", payload, "before");
			const go = yield* DurableDeferred.await(Go);
			yield* suspendingActivities.activity("step", payload, "after");
			return `before:${go}:after`;
		}),
	),
	Flaky.toLayer((payload) =>
		flakyActivities.activity("flaky", payload).pipe(Activity.retry({ times: 3 })),
	),
).pipe(Layer.provide(probe));

function start(engine: Layer.Layer<WorkflowEngine.WorkflowEngine, unknown>) {
	const runtime = ManagedRuntime.make(workflows.pipe(Layer.provideMerge(engine)));
	const run = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
		runtime.runPromise(effect);
	const retried = <A>(attempt: Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine>) =>
		run(
			attempt.pipe(
				Effect.retry({ times: 250, schedule: Schedule.spaced(Duration.millis(20)) }),
				Effect.orDie,
			),
		);
	const pollUntil = <A>(
		workflow: typeof Suspending | typeof Racing,
		executionId: string,
		done: (result: Workflow.Result<string, never>) => A | undefined,
	) =>
		retried(
			workflow
				.poll(executionId)
				.pipe(
					Effect.flatMap((result) =>
						Effect.fromOption(
							Option.flatMap(result, (value) => Option.fromUndefinedOr(done(value))),
						),
					),
				),
		);
	const completion = (
		executionId: string,
		workflow: typeof Suspending | typeof Racing = Suspending,
	) =>
		pollUntil(workflow, executionId, (result) =>
			result._tag === "Complete" ? result.exit : undefined,
		);
	return {
		run,
		untilSuspended: (
			executionId: string,
			workflow: typeof Suspending | typeof Racing = Suspending,
		) =>
			pollUntil(workflow, executionId, (result) =>
				result._tag === "Suspended" ? true : undefined,
			),
		/** Waits, briefly, for something the execution does to become true. */
		until: (check: () => boolean) =>
			retried(Effect.suspend(() => (check() ? Effect.void : Effect.fail("not yet")))),
		completion,
		result: async (
			executionId: string,
			workflow: typeof Suspending | typeof Racing = Suspending,
		) => {
			const exit = await completion(executionId, workflow);
			if (Exit.isFailure(exit)) throw new Error(`Execution failed: ${String(exit.cause)}`);
			return exit.value;
		},
		[Symbol.asyncDispose]: () => runtime.dispose(),
	};
}

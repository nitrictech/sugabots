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
import {
	Activity,
	DurableClock,
	DurableDeferred,
	Workflow,
	WorkflowEngine,
} from "effect/unstable/workflow";
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

	it("gives an activity its typed input, running it once per input", async () => {
		await using harness = start(options.engine());
		const key = crypto.randomUUID();
		const executionId = await harness.run(Inputs.execute({ key }, { discard: true }));
		await harness.untilSuspended(executionId, Inputs);
		await harness.run(
			DurableDeferred.succeed(Go, { token: goToken(executionId, Inputs), value: "go" }),
		);

		expect(await harness.result(executionId, Inputs)).toBe("a:1,a:1,b:2");
		expect(runs(key)).toEqual(["a:1", "b:2"]);
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

	it("wakes for a deferred or a timer, whichever comes first", async () => {
		await using harness = start(options.engine());
		const signalled = await harness.run(
			Waiting.execute({ key: crypto.randomUUID(), millis: 30_000 }, { discard: true }),
		);
		// A timer this short is kept in memory, so the execution never shows as
		// suspended; the deferred is sent while it is still running.
		await harness.run(
			DurableDeferred.succeed(Wake, {
				token: DurableDeferred.tokenFromExecutionId(Wake, {
					workflow: Waiting,
					executionId: signalled,
				}),
				value: undefined,
			}),
		);
		expect(await harness.result(signalled, Waiting)).toBe("woken");

		const timedOut = await harness.run(
			Waiting.execute({ key: crypto.randomUUID(), millis: 50 }, { discard: true }),
		);
		expect(await harness.result(timedOut, Waiting)).toBe("timed out");
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

interface Keyed {
	readonly key: string;
}

const Labelled = Schema.Struct({ label: Schema.String, round: Schema.Finite });

/** The conformance workflows' activities, reached as a service, as every workflow's are. */
class Probe extends Context.Service<
	Probe,
	{
		/** Records that the execution for `payload.key` ran the step `name`. */
		readonly step: (payload: Keyed, name: string) => Effect.Effect<void>;
		/** Records the labelled round it is given, and returns it as text. */
		readonly labelled: (payload: Keyed, input: typeof Labelled.Type) => Effect.Effect<string>;
		/** Fails until it has been tried more than `payload.failures` times; returns its attempts. */
		readonly flaky: (
			payload: Keyed & { readonly failures: number },
		) => Effect.Effect<number, string>;
	}
>()("@sugabots/workflow/conformance/Probe") {}

const record = (key: string, step: string) =>
	Effect.sync(() => {
		recorded.set(key, [...runs(key), step]);
	});

const probe = Layer.succeed(Probe, {
	step: ({ key }, name) => record(key, name),
	labelled: ({ key }, { label, round }) =>
		record(key, `${label}:${round}`).pipe(Effect.as(`${label}:${round}`)),
	flaky: ({ key, failures }) =>
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

const Waiting = Workflow.make("conformance/waiting", {
	payload: { key: Schema.String, millis: Schema.Finite },
	success: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

const Inputs = Workflow.make("conformance/inputs", {
	payload: { key: Schema.String },
	success: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

const Wake = DurableDeferred.make("wake");

const First = DurableDeferred.make("first", { success: Schema.String });
const Second = DurableDeferred.make("second", { success: Schema.String });

const racingToken = (deferred: typeof First, executionId: string) =>
	DurableDeferred.tokenFromExecutionId(deferred, { workflow: Racing, executionId });

const goToken = (executionId: string, workflow: Workflows = Suspending) =>
	DurableDeferred.tokenFromExecutionId(Go, { workflow, executionId });

type Workflows = typeof Suspending | typeof Racing | typeof Waiting | typeof Inputs;

export const suspendingActivities = Activities.fromService<typeof Suspending.payloadSchema.Type>()(
	Probe,
	{ step: { input: Schema.String } },
);

export const flakyActivities = Activities.fromService<typeof Flaky.payloadSchema.Type>()(Probe, {
	flaky: { success: Schema.Finite, error: Schema.String },
});

export const racingActivities = Activities.fromService<typeof Racing.payloadSchema.Type>()(Probe, {
	step: { input: Schema.String },
});

export const inputActivities = Activities.fromService<typeof Inputs.payloadSchema.Type>()(Probe, {
	labelled: { input: Labelled, success: Schema.String },
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
	Waiting.toLayer(({ millis }) =>
		DurableDeferred.raceAll({
			name: "waiting",
			success: Schema.String,
			error: Schema.Never,
			effects: [
				Effect.as(DurableDeferred.await(Wake), "woken"),
				Effect.as(
					DurableClock.sleep({ name: "timeout", duration: Duration.millis(millis) }),
					"timed out",
				),
			],
		}),
	),
	Suspending.toLayer((payload) =>
		Effect.gen(function* () {
			yield* suspendingActivities.activity("step", payload, "before");
			const go = yield* DurableDeferred.await(Go);
			yield* suspendingActivities.activity("step", payload, "after");
			return `before:${go}:after`;
		}),
	),
	Inputs.toLayer((payload) =>
		Effect.gen(function* () {
			const first = yield* inputActivities.activity("labelled", payload, { label: "a", round: 1 });
			yield* DurableDeferred.await(Go);
			const repeated = yield* inputActivities.activity("labelled", payload, {
				label: "a",
				round: 1,
			});
			const second = yield* inputActivities.activity("labelled", payload, { label: "b", round: 2 });
			return [first, repeated, second].join(",");
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
		workflow: Workflows,
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
	const completion = (executionId: string, workflow: Workflows = Suspending) =>
		pollUntil(workflow, executionId, (result) =>
			result._tag === "Complete" ? result.exit : undefined,
		);
	return {
		run,
		untilSuspended: (executionId: string, workflow: Workflows = Suspending) =>
			pollUntil(workflow, executionId, (result) =>
				result._tag === "Suspended" ? true : undefined,
			),
		/** Waits, briefly, for something the execution does to become true. */
		until: (check: () => boolean) =>
			retried(Effect.suspend(() => (check() ? Effect.void : Effect.fail("not yet")))),
		completion,
		result: async (executionId: string, workflow: Workflows = Suspending) => {
			const exit = await completion(executionId, workflow);
			if (Exit.isFailure(exit)) throw new Error(`Execution failed: ${String(exit.cause)}`);
			return exit.value;
		},
		[Symbol.asyncDispose]: () => runtime.dispose(),
	};
}

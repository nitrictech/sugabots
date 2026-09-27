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
import { Activity, DurableDeferred, Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import { expect, it } from "vitest";

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

const step = (key: string, name: string) =>
	Activity.make({
		name,
		execute: Effect.gen(function* () {
			const recorder = yield* Probe;
			yield* recorder.record(key, name);
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

const goToken = (executionId: string) =>
	DurableDeferred.tokenFromExecutionId(Go, { workflow: Suspending, executionId });

const workflows = Layer.mergeAll(
	Suspending.toLayer(({ key }) =>
		Effect.gen(function* () {
			yield* step(key, "before");
			const go = yield* DurableDeferred.await(Go);
			yield* step(key, "after");
			return `before:${go}:after`;
		}),
	),
	Flaky.toLayer(({ key, failures }) =>
		Activity.make({
			name: "flaky",
			success: Schema.Finite,
			error: Schema.String,
			execute: Effect.gen(function* () {
				const attempts = yield* Probe;
				return yield* attempts.attempt(key, failures);
			}),
		}).pipe(Activity.retry({ times: 3 })),
	),
).pipe(Layer.provide(probe));

function start(engine: Layer.Layer<WorkflowEngine.WorkflowEngine, unknown>) {
	const runtime = ManagedRuntime.make(workflows.pipe(Layer.provideMerge(engine)));
	const run = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
		runtime.runPromise(effect);
	const pollUntil = <A>(
		executionId: string,
		done: (result: Workflow.Result<string, never>) => A | undefined,
	) =>
		run(
			Suspending.poll(executionId).pipe(
				Effect.flatMap((result) =>
					Effect.fromOption(Option.flatMap(result, (value) => Option.fromUndefinedOr(done(value)))),
				),
				Effect.retry({ times: 250, schedule: Schedule.spaced(Duration.millis(20)) }),
				Effect.orDie,
			),
		);
	const completion = (executionId: string) =>
		pollUntil(executionId, (result) => (result._tag === "Complete" ? result.exit : undefined));
	return {
		run,
		untilSuspended: (executionId: string) =>
			pollUntil(executionId, (result) => (result._tag === "Suspended" ? true : undefined)),
		completion,
		result: async (executionId: string) => {
			const exit = await completion(executionId);
			if (Exit.isFailure(exit)) throw new Error(`Execution failed: ${String(exit.cause)}`);
			return exit.value;
		},
		[Symbol.asyncDispose]: () => runtime.dispose(),
	};
}

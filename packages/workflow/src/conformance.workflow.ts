/**
 * The conformance suite's workflows, in a module that can also run inside
 * Temporal's sandbox (hence `.workflow.ts`: it imports no Node or database
 * code). Tests in `conformance.ts` drive them.
 */
import { Context, Effect, Schema } from "effect";
import { Activity, DurableDeferred, Workflow } from "effect/unstable/workflow";
import { Activities } from "./activities.ts";

/** Records what the activities did, so tests can check what ran and how often. */
export class Probe extends Context.Service<
	Probe,
	{
		readonly record: (key: string, step: string) => Effect.Effect<void>;
		readonly attempt: (key: string, failures: number) => Effect.Effect<number, string>;
	}
>()("@sugabots/workflow/conformance/Probe") {}

export const Go = DurableDeferred.make("go", { success: Schema.String });

export const Suspending = Workflow.make("conformance/suspending", {
	payload: { key: Schema.String },
	success: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

export const Flaky = Workflow.make("conformance/flaky", {
	payload: { key: Schema.String, failures: Schema.Finite },
	success: Schema.Finite,
	error: Schema.String,
	idempotencyKey: (payload) => payload.key,
});

export const goToken = (executionId: string) =>
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

/** Runs a step, waits for `go`, runs another. */
export const suspending = (payload: typeof Suspending.payloadSchema.Type) =>
	Effect.gen(function* () {
		yield* suspendingActivities.activity("step", payload, "before");
		const go = yield* DurableDeferred.await(Go);
		yield* suspendingActivities.activity("step", payload, "after");
		return `before:${go}:after`;
	});

/** An activity that fails `failures` times before it succeeds. */
export const flaky = (payload: typeof Flaky.payloadSchema.Type) =>
	flakyActivities.activity("flaky", payload).pipe(Activity.retry({ times: 3 }));

/** Each workflow with its activities, for engines that rebuild activities by name. */
export const registrations = [
	{ workflow: Suspending, activities: suspendingActivities },
	{ workflow: Flaky, activities: flakyActivities },
];

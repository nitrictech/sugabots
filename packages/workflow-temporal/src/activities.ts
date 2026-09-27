/**
 * The worker side of Effect activities on Temporal: the one Temporal activity
 * that rebuilds each Effect activity by name and runs it.
 */
import type { Activities } from "@sugabots/workflow/activities";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Duration, Effect, Fiber, type ManagedRuntime, Schedule } from "effect";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { type ActivityInput, activityTypeName } from "./protocol.ts";
import { codecsFor, encodeResult } from "./wire.ts";

/** A workflow and its activities, as the worker needs them to rebuild one by name. */
export interface Registration {
	readonly workflow: Workflow.Any;
	// biome-ignore lint/suspicious/noExplicitAny: the payload type differs per workflow; `resolve` is called with that workflow's decoded payload
	readonly activities: Activities.Set<any, any>;
}

/**
 * Well inside any heartbeat timeout a worker is given, so a live activity
 * never looks dead, and cheap: Temporal throttles heartbeats itself.
 */
const HEARTBEAT_INTERVAL = Duration.seconds(10);

/**
 * The Temporal activities to give the worker: one entry, whatever the number
 * of Effect activities. `runtime` supplies the services activities need, such
 * as the database.
 */
export const makeActivities = <R>(
	registrations: ReadonlyArray<Registration>,
	runtime: ManagedRuntime.ManagedRuntime<R, never>,
) => {
	const byName = new Map(
		registrations.map((registration) => [registration.workflow._tag, registration]),
	);
	return {
		[activityTypeName]: async (input: ActivityInput): Promise<unknown> => {
			const registration = byName.get(input.workflow);
			const activity = registration?.activities.resolve(
				input.activity,
				codecsFor(registration.workflow).decodePayload(input.payload),
			);
			if (!registration || !activity) {
				throw ApplicationFailure.nonRetryable(
					`No activity "${input.activity}" for workflow "${input.workflow}" on this worker`,
				);
			}
			const program = activity.executeEncoded.pipe(
				Workflow.intoResult,
				Effect.provideService(
					WorkflowEngine.WorkflowInstance,
					WorkflowEngine.WorkflowInstance.initial(registration.workflow, input.executionId),
				),
				Effect.provideService(Activity.CurrentAttempt, input.attempt),
			) as Effect.Effect<Workflow.Result<unknown, unknown>, never, R>;
			return encodeResult(await runCancellably(runtime, program));
		},
	};
};

/**
 * Runs the activity while heartbeating, and interrupts it when Temporal
 * cancels it (the workflow was interrupted, or the heartbeat timed out).
 */
const runCancellably = <A, R>(
	runtime: ManagedRuntime.ManagedRuntime<R, never>,
	program: Effect.Effect<A, never, R>,
): Promise<A> => {
	const signal = cancellationSignal();
	const beats = Effect.sync(() => heartbeat()).pipe(
		Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)),
	);
	const fiber = runtime.runFork(Effect.raceFirst(program, Effect.andThen(beats, Effect.never)));
	const interrupt = () => void Effect.runFork(Fiber.interrupt(fiber));
	signal.addEventListener("abort", interrupt, { once: true });
	return runtime
		.runPromise(Fiber.join(fiber))
		.finally(() => signal.removeEventListener("abort", interrupt));
};

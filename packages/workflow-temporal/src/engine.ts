/**
 * Effect's `WorkflowEngine` backed by Temporal, for the processes that start,
 * poll and signal workflows. The bodies themselves run on workers (see
 * `runtime.ts` and `activities.ts`). Adapted from effect-temporal (MIT); see
 * NOTICE.
 */
import {
	type Client,
	WorkflowExecutionAlreadyStartedError,
	WorkflowFailedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { Context, Effect, Exit, Layer, Option } from "effect";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import {
	type CompleteDeferred,
	completeDeferredSignalName,
	interruptSignalName,
	resumeSignalName,
	type State,
	stateQueryName,
	workflowIdFor,
} from "./protocol.ts";
import { codecsFor, encodeExit, resultOfFailure } from "./wire.ts";

/** The Temporal connection this process uses, and the task queue its workflows run on. */
export class Temporal extends Context.Service<
	Temporal,
	{ readonly client: Client; readonly taskQueue: string }
>()("@sugabots/workflow-temporal/Temporal") {}

export const make = Effect.gen(function* () {
	const temporal = yield* Temporal;
	const handle = (workflow: string, executionId: string) =>
		temporal.client.workflow.getHandle(workflowIdFor(workflow, executionId));

	const result = (workflow: Workflow.Any, executionId: string) =>
		Effect.tryPromise(() => handle(workflow._tag, executionId).result()).pipe(
			Effect.match({
				onSuccess: (value): Workflow.Result<unknown, unknown> =>
					new Workflow.Complete({ exit: Exit.succeed(codecsFor(workflow).decodeSuccess(value)) }),
				onFailure: (error): Workflow.Result<unknown, unknown> =>
					(error.cause instanceof WorkflowFailedError
						? resultOfFailure(workflow, error.cause)
						: undefined) ?? new Workflow.Complete({ exit: Exit.die(error.cause) }),
			}),
		);

	return WorkflowEngine.makeUnsafe({
		// Registration happens on the worker, which is given the workflow functions.
		register: () => Effect.void,

		execute: (workflow, options) =>
			Effect.gen(function* () {
				yield* Effect.tryPromise(() =>
					temporal.client.workflow.start(workflow._tag, {
						workflowId: workflowIdFor(workflow._tag, options.executionId),
						taskQueue: temporal.taskQueue,
						args: [codecsFor(workflow).encodePayload(options.payload)],
						// The execution id is the idempotency key: starting it again,
						// even after it finished, attaches to it.
						workflowIdReusePolicy: "REJECT_DUPLICATE",
					}),
				).pipe(
					Effect.catch((error) =>
						error.cause instanceof WorkflowExecutionAlreadyStartedError
							? Effect.void
							: Effect.die(error.cause),
					),
				);
				if (options.discard) return undefined;
				return yield* result(workflow, options.executionId);
			}) as never,

		poll: (workflow, executionId) =>
			Effect.gen(function* () {
				const described = yield* Effect.tryPromise(() =>
					handle(workflow._tag, executionId).describe(),
				).pipe(
					Effect.asSome,
					Effect.catch((error) =>
						error.cause instanceof WorkflowNotFoundError
							? Effect.succeedNone
							: Effect.die(error.cause),
					),
				);
				if (Option.isNone(described)) return Option.none();
				if (described.value.status.name !== "RUNNING") {
					return Option.some(yield* result(workflow, executionId));
				}
				const state = yield* Effect.tryPromise(() =>
					handle(workflow._tag, executionId).query<State>(stateQueryName),
				).pipe(Effect.orDie);
				return state.status === "suspended" && state.result !== undefined
					? Option.some(codecsFor(workflow).decodeResult(state.result))
					: Option.none();
			}),

		interrupt: (workflow, executionId) =>
			signal(handle(workflow._tag, executionId), interruptSignalName),
		interruptUnsafe: (workflow, executionId) =>
			signal(handle(workflow._tag, executionId), interruptSignalName),
		resume: (workflow, executionId) => signal(handle(workflow._tag, executionId), resumeSignalName),

		activityExecute: () =>
			Effect.die(new Error("Activities run on Temporal workers, not through the client engine")),
		deferredResult: () =>
			Effect.die(
				new Error("Deferred results are read inside the workflow, not through the client engine"),
			),

		deferredDone: ({ workflowName, executionId, deferredName, exit }) =>
			signal(handle(workflowName, executionId), completeDeferredSignalName, {
				name: deferredName,
				exit: encodeExit(exit),
			} satisfies CompleteDeferred),

		scheduleClock: () =>
			Effect.die(
				new Error("Clocks are scheduled inside the workflow, not through the client engine"),
			),
	});
});

/**
 * Signals a workflow. A workflow that has finished, or never existed, has
 * nothing left to hear it, which is success: the same as a deferred sent to a
 * finished execution on Effect's own engines.
 */
const signal = (
	handle: ReturnType<Client["workflow"]["getHandle"]>,
	name: string,
	...args: ReadonlyArray<unknown>
) =>
	Effect.tryPromise(() => handle.signal(name, ...args)).pipe(
		Effect.catch((error) =>
			error.cause instanceof WorkflowNotFoundError ? Effect.void : Effect.die(error.cause),
		),
	);

export const layer = Layer.effect(WorkflowEngine.WorkflowEngine, make);

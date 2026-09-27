/**
 * Runs an Effect workflow body as a Temporal workflow, inside Temporal's
 * sandbox. Adapted from effect-temporal (MIT); see NOTICE. Differences:
 * activities go through one activity type and are rebuilt by name on the
 * worker, a deferred keeps its first value, and a body cannot start, poll or
 * signal other workflows (lanes do that, from activities).
 */
import {
	CancellationScope,
	condition,
	defineQuery,
	defineSignal,
	proxyActivities,
	setHandler,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";
import { type Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import {
	type ActivityInput,
	activityTypeName,
	type CompleteDeferred,
	completeDeferredSignalName,
	executionIdFrom,
	interruptSignalName,
	resumeSignalName,
	type State,
	stateQueryName,
} from "./protocol.ts";
import { installGlobals, scheduler } from "./sandbox.ts";
import { codecsFor, decodeExit, decodeResult, encodeExit, failureFor } from "./wire.ts";

const stateQuery = defineQuery<State>(stateQueryName);
const interruptSignal = defineSignal(interruptSignalName);
const resumeSignal = defineSignal(resumeSignalName);
const completeDeferredSignal = defineSignal<[CompleteDeferred]>(completeDeferredSignalName);

const { [activityTypeName]: runActivity } = proxyActivities<
	Record<typeof activityTypeName, (input: ActivityInput) => Promise<unknown>>
>({
	startToCloseTimeout: "10 minutes",
	// A worker that dies mid-activity is retried; a typed failure is returned
	// as a result, not thrown, so it is never retried here.
	retry: { maximumAttempts: 3 },
});

/** What one Temporal run of the workflow remembers across passes of the body. */
interface Run {
	status: State["status"];
	result: unknown;
	interrupted: boolean;
	resumed: boolean;
	readonly deferreds: Map<string, unknown>;
	readonly activityResults: Map<string, Workflow.Result<unknown, unknown>>;
	readonly clocks: Set<string>;
	readonly inFlight: Set<CancellationScope>;
	scope?: CancellationScope;
}

/**
 * The Temporal workflow function for an Effect workflow. Export it from the
 * worker's workflows module under `workflowTypeFor(workflow._tag)`. `execute` is the same
 * body given to `toLayer` for Effect's own engines; `provide` supplies what
 * it needs inside the sandbox (only step-service stubs: activities run on the
 * worker, never here).
 */
export const makeWorkflow = <W extends Workflow.Any, R>(options: {
	readonly workflow: W;
	readonly execute: (
		payload: W["payloadSchema"]["Type"],
		executionId: string,
	) => Effect.Effect<W["successSchema"]["Type"], W["errorSchema"]["Type"], R>;
	readonly provide: <A, E>(
		effect: Effect.Effect<
			A,
			E,
			R | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
		>,
	) => Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>;
}) => {
	const codecs = codecsFor(options.workflow);
	return async (encodedPayload: unknown): Promise<unknown> => {
		installGlobals();
		const executionId = executionIdFrom(workflowInfo().workflowId);
		const payload = codecs.decodePayload(encodedPayload);
		const run: Run = {
			status: "running",
			result: undefined,
			interrupted: false,
			resumed: false,
			deferreds: new Map(),
			activityResults: new Map(),
			clocks: new Set(),
			inFlight: new Set(),
		};
		installHandlers(run);

		// Non-cancellable, so a Temporal cancellation reaches the Effect runtime
		// (finalisers run) instead of tearing down awaited commands directly.
		return CancellationScope.nonCancellable(async () => {
			run.scope = CancellationScope.current();
			let instance: WorkflowEngine.WorkflowInstance["Service"] | undefined;
			let fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined;
			void condition(() => run.interrupted).then(() => {
				if (instance) {
					instance.interrupted = true;
					instance.suspended = false;
				}
				for (const scope of run.inFlight) scope.cancel();
				fiber?.interruptUnsafe();
			});

			while (true) {
				instance = WorkflowEngine.WorkflowInstance.initial(options.workflow, executionId);
				instance.interrupted = run.interrupted;
				const engine = engineFor(run, options.workflow, encodedPayload);
				const pass = instance;
				const body = options.execute(payload, executionId).pipe(
					// An interrupted execution ends as interrupted rather than
					// suspending again: finalisers run and the run completes.
					Effect.onExit(() => {
						if (!run.interrupted) return Effect.void;
						pass.interrupted = true;
						pass.suspended = false;
						return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)));
					}),
					Workflow.intoResult,
					options.provide,
					Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
					Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
				);
				fiber = Effect.runFork(body, { scheduler });
				const exit = await new Promise<Exit.Exit<Workflow.Result<unknown, unknown>>>((resolve) =>
					fiber?.addObserver(resolve),
				);
				fiber = undefined;
				const result: Workflow.Result<unknown, unknown> = Exit.isSuccess(exit)
					? exit.value
					: new Workflow.Complete({ exit: Exit.failCause(exit.cause) });

				if (result._tag === "Complete") {
					run.status = "completed";
					run.result = codecs.encodeResult(result);
					if (Exit.isSuccess(result.exit)) return codecs.encodeSuccess(result.exit.value);
					throw failureFor(options.workflow, result, result.exit.cause);
				}
				run.status = "suspended";
				run.result = codecs.encodeResult(result);
				await condition(() => run.resumed || run.interrupted);
				run.resumed = false;
				run.result = undefined;
				if (!run.interrupted) run.status = "running";
			}
		});
	};
};

function installHandlers(run: Run): void {
	setHandler(stateQuery, () => ({ status: run.status, result: run.result }));
	setHandler(interruptSignal, () => {
		run.interrupted = true;
		run.resumed = false;
	});
	setHandler(resumeSignal, () => {
		run.resumed = true;
	});
	setHandler(completeDeferredSignal, ({ name, exit }) => completeDeferred(run, name, exit));
}

/** A deferred keeps its first value, on every engine. Later values are ignored. */
function completeDeferred(run: Run, name: string, exit: unknown): void {
	if (run.deferreds.has(name)) return;
	run.deferreds.set(name, exit);
	if (!run.interrupted) run.resumed = true;
}

/** The engine the body sees inside the sandbox, for this execution only. */
function engineFor(
	run: Run,
	workflow: Workflow.Any,
	encodedPayload: unknown,
): WorkflowEngine.WorkflowEngine["Service"] {
	const notInBody = (what: string) =>
		Effect.die(
			new Error(`${what} is not available inside a workflow body; do it from an activity`),
		);
	const isSelf = (name: string, executionId: string) =>
		name === workflow._tag && executionId === executionIdFrom(workflowInfo().workflowId);
	return WorkflowEngine.makeUnsafe({
		register: () => notInBody("Registering a workflow"),
		execute: () => notInBody("Starting a workflow"),
		poll: () => notInBody("Polling a workflow"),
		interrupt: (target, executionId) =>
			isSelf(target._tag, executionId)
				? Effect.sync(() => {
						run.interrupted = true;
					})
				: notInBody("Interrupting another workflow"),
		interruptUnsafe: (target, executionId) =>
			isSelf(target._tag, executionId)
				? Effect.sync(() => {
						run.interrupted = true;
					})
				: notInBody("Interrupting another workflow"),
		resume: () => Effect.void,
		activityExecute: (activity: Activity.Any, attempt: number) =>
			Effect.suspend(() => {
				const key = `${activity.name}/${attempt}`;
				const memoised = run.activityResults.get(key);
				if (memoised) return Effect.succeed(memoised);
				const scope = new CancellationScope(
					run.scope ? { cancellable: true, parent: run.scope } : undefined,
				);
				run.inFlight.add(scope);
				return Effect.promise(() =>
					scope.run(() =>
						runActivity({
							workflow: workflow._tag,
							activity: activity.name,
							executionId: executionIdFrom(workflowInfo().workflowId),
							payload: encodedPayload,
							attempt,
						}),
					),
				).pipe(
					Effect.map(decodeResult),
					Effect.tap((result) =>
						Effect.sync(() => {
							if (result._tag === "Complete") run.activityResults.set(key, result);
						}),
					),
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) scope.cancel();
							run.inFlight.delete(scope);
						}),
					),
				);
			}),
		deferredResult: (deferred) =>
			Effect.sync(() => {
				const exit = run.deferreds.get(deferred.name);
				return exit === undefined ? Option.none() : Option.some(decodeExit(exit));
			}),
		deferredDone: ({ workflowName, executionId, deferredName, exit }) =>
			isSelf(workflowName, executionId)
				? Effect.sync(() => completeDeferred(run, deferredName, encodeExit(exit)))
				: notInBody("Completing another workflow's deferred"),
		scheduleClock: (target, { executionId, clock }) =>
			isSelf(target._tag, executionId)
				? Effect.sync(() => {
						if (run.clocks.has(clock.name)) return;
						run.clocks.add(clock.name);
						void CancellationScope.nonCancellable(() =>
							sleep(Duration.toMillis(clock.duration)),
						).then(() => completeDeferred(run, clock.deferred.name, encodeExit(Exit.void)));
					})
				: notInBody("Scheduling another workflow's clock"),
	});
}

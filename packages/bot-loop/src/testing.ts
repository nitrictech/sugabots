import { Accounts } from "@sugabots/core/accounts/accounts";
import { SystemWorkAuthentication } from "@sugabots/core/authentication/system-work";
import { TurnAuthentication } from "@sugabots/core/authentication/turn";
import { chatServicesForTests, standInTurnSignals } from "@sugabots/core/chats/testing";
import { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { noComputers } from "@sugabots/core/computers/testing";
import { afterCommit as afterTransaction, Database } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import { inMemoryEventStore } from "@sugabots/core/database/events/testing";
import { connector, message, searchProvider, toolCall, turn } from "@sugabots/core/database/schema";
import {
	onDatabase,
	onPostgres,
	promising,
	runOnPostgres,
	type TestInfrastructure,
} from "@sugabots/core/database/testing";
import { Email } from "@sugabots/core/email/email";
import { layerWithConnectorCalls } from "@sugabots/core/operations/layer";
import { Operations } from "@sugabots/core/operations/registry";
import { servedOperations } from "@sugabots/core/operations/testing";
import type { BotPrincipal } from "@sugabots/core/principal";
import { ConnectorCalls } from "@sugabots/core/providers/connectors/connector-calls";
import { Models } from "@sugabots/core/providers/models/models";
import { chunks, streamed } from "@sugabots/core/providers/models/testing";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { type AssistantModelMessage, tool } from "ai";
import { eq } from "drizzle-orm";
import {
	Cause,
	Clock,
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Schema,
	Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { WorkflowEngine } from "effect/unstable/workflow";
import { onTestFinished } from "vitest";
import * as Signals from "./signals.ts";
import * as Steps from "./steps.ts";
import { type StepPlace, type StepResult, Turn, TurnSteps, turnWorkflow } from "./turn.workflow.ts";

/** How long an approval waits for a decision before the scheduler expires it. */
const APPROVAL_LIFETIME = Duration.days(7);

/** What a scripted model answers one request with: its text, and the tool calls it makes. */
export interface ScriptedStep {
	readonly text?: readonly string[];
	readonly thinking?: readonly string[];
	readonly thinkingProviderOptions?: AssistantModelMessage["providerOptions"];
	readonly calls?: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
	readonly contextTokens?: number;
}

/**
 * A model that answers each request with the next of `steps`, failing with a
 * request failure where one is given, and keeps every request it was sent.
 * A request past the last of `steps` dies, and fails the case when it
 * finishes: the loop records a model request that died as a failure it may
 * retry, so the death alone may not show.
 */
export function scriptedSteps(...steps: ReadonlyArray<ScriptedStep | Models.RequestFailure>) {
	const requests: Models.StreamRequest[] = [];
	let unscripted = 0;
	onTestFinished(() => {
		if (unscripted > 0) {
			throw new Error(
				`The model was sent ${unscripted} request(s) past the ${steps.length} it was scripted for`,
			);
		}
	});
	const model = Models.fromStream((request) => {
		requests.push(request);
		const next = steps[requests.length - 1];
		if (next === undefined) {
			unscripted++;
			return Effect.die(new Error(`Request ${requests.length} was not scripted`));
		}
		if (Models.isRequestFailure(next)) return Effect.fail(next);
		const text = next.text ?? [];
		const thinking = next.thinking ?? [];
		const calls = next.calls ?? [];
		const answered: AssistantModelMessage = {
			role: "assistant",
			content: [
				...(thinking.length > 0
					? [
							{
								type: "reasoning" as const,
								text: thinking.join(""),
								providerOptions: next.thinkingProviderOptions,
							},
						]
					: []),
				...(text.length > 0 ? [{ type: "text" as const, text: text.join("") }] : []),
				...calls.map((call) => ({ type: "tool-call" as const, ...call })),
			],
		};
		return Effect.succeed(
			streamed(
				chunks(...text),
				{
					toolCalls: [...calls],
					responseMessages: [answered],
					...(next.contextTokens === undefined ? {} : { contextTokens: next.contextTokens }),
				},
				thinking,
			),
		);
	});
	return { model, requests };
}

/** A step calling `toolName` with `input`, then a step that says it is done. */
export const calling = (toolName: string, input: unknown) =>
	scriptedSteps({ calls: [{ toolCallId: "sdk-1", toolName, input }] }, { text: ["Done."] });

/**
 * What a model request was given back for its tool call `toolCallId`: the
 * output of the tool result the request carries for it.
 */
export function toolResultFor(request: Models.StreamRequest | undefined, toolCallId: string) {
	for (const sent of request?.continuationMessages ?? []) {
		if (sent.role !== "tool") continue;
		for (const part of sent.content) {
			if (part.type === "tool-result" && part.toolCallId === toolCallId) return part.output;
		}
	}
	throw new Error(`The request carries no result for the call ${toolCallId}`);
}

/** The page the web tools fetch in a case, and what fetching it answers. */
export const examplePage = {
	url: "https://example.com/",
	response: () => new Response("Hello!"),
};

/** Where the workspace's web search provider is, once `enableWebSearch` adds it. */
export const searchBaseUrl = "https://search.example.com";

/** Turns the web tools on in `workspaceId`, through a SearXNG provider `adminId` added. */
export const enableWebSearch = (workspaceId: string, adminId: string) =>
	onDatabase((db) =>
		db.insert(searchProvider).values({
			workspaceId,
			builtIn: "searxng",
			baseUrl: searchBaseUrl,
			enabled: true,
			createdById: adminId,
		}),
	);

/** What the model is given back for a call that failed with `error`. */
export const failedCall = (error: string | null | undefined) => ({
	type: "json",
	value: { status: "failed", error },
});

/**
 * A connector tool `wiki__wipe` of the connector `connectorId`, that may
 * change things, with `access`, running `execute`. Its access is written to
 * the connector as each step reads it, as members set it.
 */
export const wikiWipe = (
	connectorId: string,
	access: "allow" | "ask" | "off",
	execute: (input: unknown, options: { readonly abortSignal?: AbortSignal }) => Promise<unknown>,
): ConnectorCatalog.Interface => ({
	forTurn: () =>
		Effect.promise(async () => {
			await onDatabase((db) =>
				db
					.update(connector)
					.set({ handle: "wiki", toolAccess: { wipe: access } })
					.where(eq(connector.id, connectorId)),
			);
			return {
				tools: {
					wiki__wipe: {
						described: { name: "wipe", readOnly: false, destructive: null },
						tool: tool({
							inputSchema: Schema.Struct({}).pipe(
								Schema.toStandardSchemaV1,
								Schema.toStandardJSONSchemaV1,
							),
							execute,
						}),
						writeOrDelete: true,
						access,
						connectorId,
						handle: "wiki",
						description: "",
						inputSchema: { type: "object" as const },
						connectorRevision: 1,
						remoteToolName: "wipe",
					},
				},
				unavailable: [],
				signInExpired: [],
				instructions: {},
				addable: [],
				fromProjectAndBot: false,
				close: async () => undefined,
			};
		}),
});

/** The stored turn `turnId`. */
export const storedTurn = async (turnId: string) => {
	const [row] = await onDatabase((db) => db.select().from(turn).where(eq(turn.id, turnId)));
	return row;
};

/** The stored reply of the turn `turnId`. */
export const storedReply = async (turnId: string) => {
	const [row] = await onDatabase((db) =>
		db.select().from(message).where(eq(message.turnId, turnId)),
	);
	return row;
};

/** The stored tool calls of the turn `turnId`. */
export const callsOf = (turnId: string) =>
	onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.turnId, turnId)));

/**
 * The turn that `executionId` opened, whose calls are parked for approval,
 * with the first of them.
 */
export async function parkedCallOf(executionId: string) {
	const [opened] = await onDatabase((db) =>
		db.select({ id: turn.id }).from(turn).where(eq(turn.executionId, executionId)),
	);
	if (!opened) throw new Error("No turn opened");
	const [parked] = await callsOf(opened.id);
	if (!parked?.approvalId) throw new Error("No call parked");
	return { turnId: opened.id, parked: { ...parked, approvalId: parked.approvalId } };
}

/**
 * A clock a case moves by hand, for the steps' timeout and their reads of
 * where the turn stands. It starts at the current time, so what the steps
 * write is dated as usual, and is closed when the case finishes.
 */
export async function controlledClock() {
	const scope = Scope.makeUnsafe();
	onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
	const testClock = await Effect.runPromise(Scope.provide(TestClock.make(), scope));
	await Effect.runPromise(testClock.setTime(Date.now()));
	/** The sleeps waiting on the clock, in the order they were asked for. */
	const waiting: Duration.Duration[] = [];
	const checks = new Set<() => void>();
	const clock: Clock.Clock = {
		...testClock,
		sleep: (duration) =>
			Effect.suspend(() => {
				const asleep = { duration };
				waiting.push(duration);
				for (const check of checks) check();
				return testClock.sleep(duration).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							waiting.splice(waiting.indexOf(asleep.duration), 1);
						}),
					),
				);
			}),
	};
	return {
		clock,
		/**
		 * Resolves, once at least `count` sleeps wait on the clock, with how long
		 * each that waits was asked for, in milliseconds, shortest first.
		 */
		waiting: (count: number) =>
			new Promise<readonly number[]>((resolve) => {
				const check = () => {
					if (waiting.length < count) return;
					checks.delete(check);
					resolve(waiting.map(Duration.toMillis).toSorted((left, right) => left - right));
				};
				checks.add(check);
				check();
			}),
		/** Moves the clock on by `duration`, waking what slept until then. */
		adjust: (duration: Duration.Duration) => Effect.runPromise(testClock.adjust(duration)),
	};
}

/**
 * How far one execution of the turn workflow on the memory engine has got,
 * as a case waits for it. A run ends suspended at rest when no deferred of
 * the execution completed since the run began: each completion wakes the
 * execution for another run. A durable clock's wake-up is not counted, so a
 * sleeping execution counts as suspended.
 *
 * A wait for a milestone the execution can no longer reach fails, naming
 * what was awaited and what happened instead: the execution completed, died,
 * or was closed with the case.
 */
function progressOf(executionId: string) {
	const laneGrantedPrefix = Lanes.laneGranted("").name;
	const completedDeferreds = new Set<string>();
	let wakes = 0;
	let resting = false;
	let lanesGranted = 0;
	let ended:
		| { readonly _tag: "Completed" }
		| { readonly _tag: "Died"; readonly cause: unknown }
		| { readonly _tag: "Closed" }
		| undefined;
	const checks = new Set<() => void>();
	const recheck = () => {
		for (const check of checks) check();
	};
	/** What the execution was doing when it last changed. */
	const lastSeen = () => (resting ? "suspended" : "running");
	/** Resolves once `ready` holds, rejecting once the execution can no longer get to `milestone`. */
	const until = (milestone: string, ready: () => boolean) =>
		new Promise<void>((resolve, reject) => {
			const check = () => {
				if (ready()) {
					checks.delete(check);
					resolve();
				} else if (ended?._tag === "Died") {
					checks.delete(check);
					reject(ended.cause);
				} else if (ended !== undefined) {
					checks.delete(check);
					const how = ended._tag === "Completed" ? "completed" : `was closed while ${lastSeen()}`;
					reject(new Error(`Expected the turn's workflow to be ${milestone}, but it ${how}`));
				}
			};
			checks.add(check);
			check();
		});
	return {
		executionId,
		/** Records that a run began, and returns what records how it ended. */
		runStarted: () => {
			resting = false;
			const wakesAtStart = wakes;
			return (exit: Exit.Exit<unknown, unknown>, suspended: boolean) => {
				if (Exit.isSuccess(exit)) ended = { _tag: "Completed" };
				else if (suspended) resting = wakes === wakesAtStart;
				else ended = { _tag: "Died", cause: Cause.squash(exit.cause) };
				recheck();
			};
		},
		/** Records that the deferred `name` of the execution completed, unless it already had. */
		deferredCompleted: (name: string) => {
			if (completedDeferreds.has(name)) return;
			completedDeferreds.add(name);
			wakes++;
			resting = false;
			if (name.startsWith(laneGrantedPrefix)) lanesGranted++;
			recheck();
		},
		/** Records that the engine the execution ran on was closed. */
		closed: () => {
			if (ended !== undefined) return;
			ended = { _tag: "Closed" };
			recheck();
		},
		suspended: () => until("suspended", () => resting),
		laneGranted: () => until("granted its lane", () => lanesGranted > 0),
		completed: () => until("completed", () => ended?._tag === "Completed"),
	};
}

/**
 * The memory engine, holding a deferred's result back until the transaction
 * that sets it commits, as the Postgres engine stores it with the transaction
 * (otherwise a lane granted in a transaction would resume its turn inside
 * it), and telling `progress` how its execution's runs end and which of its
 * deferreds complete.
 */
const observedMemoryEngine = (progress: ReturnType<typeof progressOf>) =>
	Layer.effect(
		WorkflowEngine.WorkflowEngine,
		Effect.gen(function* () {
			const engine = yield* WorkflowEngine.WorkflowEngine;
			yield* Effect.addFinalizer(() => Effect.sync(progress.closed));
			return WorkflowEngine.WorkflowEngine.of({
				...engine,
				register: (workflow, execute) =>
					engine.register(workflow, (payload, executionId) => {
						if (executionId !== progress.executionId) return execute(payload, executionId);
						const runEnded = progress.runStarted();
						return execute(payload, executionId).pipe(
							Effect.onExit((exit) =>
								Effect.map(Effect.service(WorkflowEngine.WorkflowInstance), (instance) =>
									runEnded(exit, instance.suspended),
								),
							),
						);
					}),
				// The turn's deferreds' schemas need no services to encode.
				deferredDone: (deferred, options) =>
					afterTransaction(
						Effect.suspend(() => {
							if (options.executionId === progress.executionId) {
								progress.deferredCompleted(options.deferredName);
							}
							return engine.deferredDone(deferred, options) as Effect.Effect<void>;
						}),
					),
			});
		}),
	).pipe(Layer.provideMerge(WorkflowEngine.layerMemory));

/**
 * The memory engine, observing the execution `executionId` of a workflow, and
 * what a case waits for of it: `suspended` resolves once it waits with nothing
 * left to wake it, `laneGranted` once its lane is granted back to it, and
 * `completed` once it completes. Each rejects if a run of it dies, or once it
 * can no longer get there: it completed, or its engine closed with the case.
 */
export function observedExecution(executionId: string) {
	const progress = progressOf(executionId);
	return {
		engine: observedMemoryEngine(progress),
		suspended: progress.suspended,
		laneGranted: progress.laneGranted,
		completed: progress.completed,
	};
}

/** How a case runs a turn's steps. */
export interface LoopOptions {
	/** The clock the steps time themselves by, instead of the real one. */
	readonly clock?: Clock.Clock;
	/**
	 * Waited for before each operation the steps call, by its name, so a case
	 * can hold a step between two of its writes.
	 */
	readonly beforeOperation?: (name: string) => Promise<void>;
}

/** The operations, each waiting for `beforeOperation` first where it is given. */
const gatedOperations = (beforeOperation: LoopOptions["beforeOperation"]) =>
	Layer.effect(
		Operations.Service,
		Effect.map(Effect.service(Operations.Service), (operations) => {
			if (!beforeOperation) return operations;
			return new Proxy(operations, {
				get: (target, name, receiver) => {
					const operation = Reflect.get(target, name, receiver);
					if (typeof operation !== "function" || typeof name !== "string") return operation;
					return (...input: unknown[]) =>
						Effect.andThen(
							Effect.promise(() => beforeOperation(name)),
							operation.apply(target, input),
						);
				},
			});
		}),
	);

/** What a case's bot loop runs over besides the database: what it reaches outside. */
export interface Outside {
	readonly model: Models.Interface;
	readonly events?: EventBus.Interface;
	readonly egress?: Layer.Layer<Egress.Service>;
	readonly connectorTools?: ConnectorCatalog.Interface;
}

/**
 * The bot loop's steps over the real operations and chat services on the test
 * database, as the server composes them, with `outside` standing in for the
 * model and the tools' outside systems. `delivered` collects what the chat
 * services' events delivered.
 */
export async function botLoopOnPostgres(
	delivered: CommittedEvent[],
	afterCommit?: (events: readonly CommittedEvent[]) => Promise<void>,
) {
	const workflows = new Map<string, Turns.TurnSignals.Interface>();
	const bus = {
		publishCommitted: async (events: readonly CommittedEvent[]) => {
			delivered.push(...events);
			await afterCommit?.(events);
		},
	};
	const services = await chatServicesForTests(bus, {
		decide: (signal) => {
			const signals = workflows.get(signal.executionId);
			return signals ? afterTransaction(signals.decide(signal)) : standInTurnSignals.decide(signal);
		},
		cancel: (executionId) => {
			const signals = workflows.get(executionId);
			return signals
				? afterTransaction(signals.cancel(executionId))
				: standInTurnSignals.cancel(executionId);
		},
		withdraw: (signal) => {
			const signals = workflows.get(signal.executionId);
			return signals
				? afterTransaction(signals.withdraw(signal))
				: standInTurnSignals.withdraw(signal);
		},
	});
	const call = await servedOperations({ chats: services });

	const environments: Array<{ outside: Outside; built: ReturnType<typeof buildEnvironment> }> = [];
	const environmentFor = (outside: Outside) => {
		const existing = environments.find(
			({ outside: saved }) =>
				saved.model === outside.model &&
				saved.events === outside.events &&
				saved.egress === outside.egress &&
				saved.connectorTools === outside.connectorTools,
		);
		if (existing) return existing.built;

		const scope = Scope.makeUnsafe();
		const environment = { outside, built: buildEnvironment(outside, scope) };
		environments.push(environment);
		onTestFinished(async () => {
			environments.splice(environments.indexOf(environment), 1);
			await Effect.runPromise(Scope.close(scope, Exit.void));
		});
		return environment.built;
	};

	const buildEnvironment = (outside: Outside, scope: Scope.Closeable) => {
		const surroundings = Layer.mergeAll(
			noComputers,
			Layer.succeedContext(services),
			Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
			unimplemented(Accounts.Service, { requireEmailVerification: false }),
			Layer.succeed(
				EventBus.Service,
				outside.events ?? EventBus.inProcess({ store: inMemoryEventStore() }),
			),
			EventStore.layer,
			Layer.succeed(Models.Service, outside.model),
		);
		const environment = Layer.mergeAll(
			Turns.Runs.layer,
			Turns.Tools.layer,
			TurnAuthentication.layer,
		).pipe(
			Layer.provideMerge(
				layerWithConnectorCalls(
					ConnectorCalls.from(outside.connectorTools ?? ConnectorCatalog.none),
				).pipe(Layer.provide(outside.egress ?? unimplemented(Egress.Service))),
			),
			Layer.provideMerge(surroundings),
		);
		return runOnPostgres(Layer.buildWithScope(environment, scope));
	};

	/**
	 * loopOver builds the steps and turn authenticator over outside, using
	 * options for the clock and operation gates. Turns in one test share their
	 * operation registry when their models and other services are identical.
	 */
	const loopOver = async (outside: Outside, options: LoopOptions = {}) => {
		const environment = await environmentFor(outside);
		const loop = Steps.layer.pipe(
			Layer.provide(gatedOperations(options.beforeOperation)),
			Layer.provideMerge(Layer.succeedContext(environment)),
		);
		const scope = Scope.makeUnsafe();
		onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
		const built = await runOnPostgres(Layer.buildWithScope(loop, scope));
		const { clock } = options;
		const onClock = clock
			? promising<TestInfrastructure>((effect) =>
					runOnPostgres(Effect.provideService(effect, Clock.Clock, clock)),
				)
			: onPostgres;
		return {
			built,
			steps: onClock(Context.get(built, TurnSteps)),
			authentication: onPostgres(Context.get(built, TurnAuthentication.Service)),
		};
	};

	/**
	 * Runs the turn running in `chatId` as its workflow would: opens it,
	 * authenticates it, and takes steps over `outside`, on `options.clock` where
	 * one is given, until one does not say to carry on. Returns each step's
	 * outcome, and the turn's id.
	 */
	const runTurn = async (
		chatId: string,
		outside: Outside,
		options: {
			readonly beforeSteps?: (turnId: string) => Promise<unknown>;
			readonly clock?: Clock.Clock;
		} = {},
	) => {
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const { steps, authentication } = await loopOver(outside, { clock: options.clock });
		const opened = await steps.open(run.request, 0);
		if (opened._tag !== "Opened") throw new Error("the turn may not run");
		await options.beforeSteps?.(opened.turnId);
		const principal = await authentication.authenticate(opened.turnId);
		const outcomes = [];
		for (let step = 0; ; step++) {
			const place: StepPlace = { turnId: opened.turnId, attempt: 0, step };
			const outcome = await steps.step(run.request, principal, place);
			outcomes.push(outcome);
			if (outcome._tag !== "Continue") break;
		}
		return { run, turnId: opened.turnId, principal, outcomes, steps, authentication };
	};

	/**
	 * Runs a real turn workflow, delivering the chat services' signals to its
	 * memory engine, until the case finishes. What it returns waits for the
	 * workflow to get somewhere: `suspended` resolves once it waits with
	 * nothing left to wake it, `laneGranted` once its lane is granted back to
	 * it, and `completed` once it completes. Each rejects if a run of it dies, or
	 * once it can no longer get there.
	 */
	const runWorkflow = async (chatId: string, outside: Outside) => {
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const { built } = await loopOver(outside);
		const database = await runOnPostgres(Effect.service(Database));
		const execution = observedExecution(run.executionId);
		const runtime = ManagedRuntime.make(
			turnWorkflow.layer.pipe(
				Layer.provideMerge(Signals.layer),
				Layer.provideMerge(Lanes.layerFor([Turn])),
				Layer.provideMerge(execution.engine),
				Layer.provide(Layer.succeed(Database, database)),
				Layer.provide(Layer.succeedContext(built)),
			),
		);
		onTestFinished(async () => {
			workflows.delete(run.executionId);
			await runtime.dispose();
		});
		workflows.set(
			run.executionId,
			await runtime.runPromise(Effect.service(Turns.TurnSignals.Service)),
		);
		await runtime.runPromise(Turn.execute(run.request, { discard: true }));
		return {
			...run,
			suspended: execution.suspended,
			laneGranted: execution.laneGranted,
			completed: execution.completed,
			/**
			 * Frees the lane `other` holds, as its workflow's last step does,
			 * granting it to the oldest request queued there, through this
			 * workflow's engine, so a grant to this turn reaches it.
			 */
			releaseLaneOf: (other: Turns.TurnRun) =>
				runtime.runPromise(
					Effect.flatMap(Lanes.Service, (lanes) =>
						lanes.release({
							key: Turns.TurnRequests.turnLane(other.request),
							executionId: other.executionId,
						}),
					),
				),
		};
	};

	/**
	 * The scheduler's expiry of the approval `parked` waits for, as the call
	 * that makes it, once the approval is backdated past its seven days.
	 */
	const expiryOf = async (parked: { readonly id: string; readonly approvalId: string }) => {
		await onDatabase((db) =>
			db
				.update(toolCall)
				.set({ approvalAskedAt: new Date(Date.now() - Duration.toMillis(APPROVAL_LIFETIME)) })
				.where(eq(toolCall.id, parked.id)),
		);
		const systemWork = await runOnPostgres(
			Effect.provide(SystemWorkAuthentication.Service, SystemWorkAuthentication.layer),
		);
		const principal = await runOnPostgres(systemWork.approvalExpiry(parked.approvalId));
		return () => call(principal, "approvals.expire", { approvalId: parked.approvalId });
	};

	return { services, call, loopOver, runTurn, runWorkflow, expiryOf };
}

/**
 * Takes step `step` of the turn `ran` waited in, once its parked calls were
 * decided, as the workflow does when it resumes the turn: authenticating it
 * again first.
 */
export async function resumeAt(
	ran: {
		readonly run: Turns.TurnRun;
		readonly turnId: string;
		readonly steps: {
			readonly step: (...args: Parameters<TurnSteps["Service"]["step"]>) => Promise<StepResult>;
		};
		readonly authentication: { readonly authenticate: (turnId: string) => Promise<BotPrincipal> };
	},
	step: number,
) {
	return ran.steps.step(ran.run.request, await ran.authentication.authenticate(ran.turnId), {
		turnId: ran.turnId,
		attempt: 0,
		step,
	});
}

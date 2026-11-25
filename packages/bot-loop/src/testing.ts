import { Accounts } from "@sugabots/core/accounts/accounts";
import { TurnAuthentication } from "@sugabots/core/authentication/turn";
import { chatServicesForTests } from "@sugabots/core/chats/testing";
import { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { noComputers } from "@sugabots/core/computers/testing";
import { afterCommit as afterTransaction, Database } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { EventStore } from "@sugabots/core/database/events/store";
import { onPostgres, runOnPostgres } from "@sugabots/core/database/testing";
import { Email } from "@sugabots/core/email/email";
import { layerWithConnectorCalls } from "@sugabots/core/operations/layer";
import { servedOperations } from "@sugabots/core/operations/testing";
import { ConnectorCalls } from "@sugabots/core/providers/connectors/connector-calls";
import { Models } from "@sugabots/core/providers/models/models";
import { chunks, streamed } from "@sugabots/core/providers/models/testing";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { Lanes } from "@sugabots/core/workflows/lanes";
import type { AssistantModelMessage } from "ai";
import { Context, Duration, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import * as Signals from "./signals.ts";
import * as Steps from "./steps.ts";
import { type StepPlace, Turn, TurnSteps, turnWorkflow } from "./turn.workflow.ts";

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
 */
export function scriptedSteps(...steps: ReadonlyArray<ScriptedStep | Models.RequestFailure>) {
	const requests: Models.StreamRequest[] = [];
	const model = Models.fromStream((request) => {
		requests.push(request);
		const next = steps[requests.length - 1] ?? { text: ["(no more steps scripted)"] };
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

/**
 * The memory engine, holding a deferred's result back until the transaction
 * that sets it commits, as the Postgres engine stores it with the transaction.
 * Otherwise a lane granted in a transaction would resume its turn inside it.
 */
const memoryEngineAfterCommit = Layer.effect(
	WorkflowEngine.WorkflowEngine,
	Effect.map(Effect.service(WorkflowEngine.WorkflowEngine), (engine) =>
		WorkflowEngine.WorkflowEngine.of({
			...engine,
			// The turn's deferreds' schemas need no services to encode.
			deferredDone: (deferred, options) =>
				afterTransaction(engine.deferredDone(deferred, options) as Effect.Effect<void>),
		}),
	),
).pipe(Layer.provideMerge(WorkflowEngine.layerMemory));

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
	const standIns = Context.get(await chatServicesForTests(bus), Turns.TurnSignals.Service);
	const services = await chatServicesForTests(bus, {
		decide: (signal) => {
			const signals = workflows.get(signal.executionId);
			return signals ? afterTransaction(signals.decide(signal)) : standIns.decide(signal);
		},
		cancel: (executionId) => {
			const signals = workflows.get(executionId);
			return signals ? afterTransaction(signals.cancel(executionId)) : standIns.cancel(executionId);
		},
		withdraw: (signal) => {
			const signals = workflows.get(signal.executionId);
			return signals ? afterTransaction(signals.withdraw(signal)) : standIns.withdraw(signal);
		},
	});
	const call = await servedOperations({ chats: services });

	/**
	 * The steps, and the authenticator the workflow resumes each turn with,
	 * over `outside`, timed as `timing` says where it says.
	 */
	const loopOver = async (outside: Outside, timing: Partial<Steps.Timing> = {}) => {
		const surroundings = Layer.mergeAll(
			noComputers,
			Layer.succeedContext(services),
			Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
			unimplemented(Accounts.Service, { requireEmailVerification: false }),
			Layer.succeed(
				EventBus.Service,
				outside.events ?? EventBus.inProcess({ store: EventStore.inMemory() }),
			),
			EventStore.layer,
			Layer.succeed(Models.Service, outside.model),
		);
		// Read often, so a case sees a stop or a takeover at once.
		const loop = Steps.layerWith({
			...Steps.timing,
			checkEvery: Duration.millis(50),
			...timing,
		}).pipe(
			Layer.provideMerge(
				Layer.mergeAll(Turns.Runs.layer, Turns.Tools.layer, TurnAuthentication.layer),
			),
			Layer.provideMerge(
				layerWithConnectorCalls(
					ConnectorCalls.from(outside.connectorTools ?? ConnectorCatalog.none),
				).pipe(Layer.provide(outside.egress ?? unimplemented(Egress.Service))),
			),
			Layer.provideMerge(surroundings),
		);
		const built = await runOnPostgres(
			Effect.gen(function* () {
				return yield* Layer.buildWithScope(loop, yield* Scope.make());
			}),
		);
		return {
			built,
			steps: onPostgres(Context.get(built, TurnSteps)),
			authentication: onPostgres(Context.get(built, TurnAuthentication.Service)),
		};
	};

	/**
	 * Runs the turn running in `chatId` as its workflow would: opens it,
	 * authenticates it, and takes steps over `outside` until one does not say
	 * to carry on. Returns each step's outcome, and the turn's id.
	 */
	const runTurn = async (
		chatId: string,
		outside: Outside,
		options: {
			readonly beforeSteps?: (turnId: string) => Promise<unknown>;
			readonly timing?: Partial<Steps.Timing>;
		} = {},
	) => {
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const { steps, authentication } = await loopOver(outside, options.timing);
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

	/** Runs a real turn workflow, delivering the chat services' signals to its memory engine. */
	const runWorkflow = async (chatId: string, outside: Outside) => {
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("no turn running");
		const { built } = await loopOver(outside);
		const database = await runOnPostgres(Effect.service(Database));
		const runtime = ManagedRuntime.make(
			turnWorkflow.layer.pipe(
				Layer.provideMerge(Signals.layer),
				Layer.provideMerge(Lanes.layerFor([Turn])),
				Layer.provideMerge(memoryEngineAfterCommit),
				Layer.provide(Layer.succeed(Database, database)),
				Layer.provide(Layer.succeedContext(built)),
			),
		);
		workflows.set(
			run.executionId,
			await runtime.runPromise(Effect.service(Turns.TurnSignals.Service)),
		);
		await runtime.runPromise(Turn.execute(run.request, { discard: true }));
		return {
			...run,
			poll: () => runtime.runPromise(Turn.poll(run.executionId)),
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
			close: async () => {
				workflows.delete(run.executionId);
				await runtime.dispose();
			},
		};
	};

	return { services, call, loopOver, runTurn, runWorkflow };
}

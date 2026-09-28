import { Effect, Layer, ManagedRuntime } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { runOnPostgres } from "../database/testing.ts";
import { unimplemented } from "../testing.ts";
import { Lanes } from "../workflows/lanes.ts";
import { Conversations } from "./conversations.ts";
import { RoutineRuns } from "./routines/runs.ts";
import { TurnRequests, TurnSignals, turnInternalsForTests } from "./turns/testing.ts";
import { Turns } from "./turns/turns.ts";
import { ConversationWorkflows } from "./workflows.ts";

/**
 * A workflow engine for the Postgres cases. The workflows it starts only hold
 * their lanes: a case runs their steps itself, and frees each lane as the
 * workflow's last step would.
 */
const held = () => DurableDeferred.await(DurableDeferred.make("released"));

export const engineForTests = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.empty,
		...ConversationWorkflows.definitions.map((definition) => definition.toLayer(held)),
	).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
).runSync(Effect.service(WorkflowEngine.WorkflowEngine));

/** Lanes over the test engine, in the caller's database. */
export const lanesForTests = Lanes.make(ConversationWorkflows.definitions).pipe(
	Effect.provideService(WorkflowEngine.WorkflowEngine, engineForTests),
);

/** The test engine and lanes over it, as the services that start and signal workflows need them. */
export const workflowsForTests = Layer.merge(
	Layer.effect(Lanes.Service, lanesForTests),
	Layer.succeed(WorkflowEngine.WorkflowEngine, engineForTests),
);

/**
 * The conversation services as the server composes them, on the test
 * database and engine (see `workflowsForTests`), with stream events delivered
 * to `bus`: a context holding them, what they are composed from, and the
 * turn internals a case drives directly (see `turnInternalsForTests`).
 * `signals`, when given, replaces how turns' workflows are signalled.
 */
export const conversationsForTests = (
	bus: Pick<EventBus.Interface, "publishCommitted">,
	signals?: TurnSignals.Interface,
) => {
	const composedFrom = Layer.mergeAll(
		TurnRequests.layer,
		signals ? Layer.succeed(TurnSignals.Service, signals) : Turns.signalsLayer,
		RoutineRuns.layer,
	).pipe(
		Layer.provide(workflowsForTests),
		Layer.merge(EventOutbox.layer.pipe(Layer.provide(unimplemented(EventBus.Service, bus)))),
	);
	return runOnPostgres(
		Effect.context<
			| Conversations.Services
			| Layer.Success<typeof composedFrom>
			| Layer.Success<typeof turnInternalsForTests>
		>().pipe(
			Effect.provide(
				turnInternalsForTests.pipe(
					Layer.provideMerge(Conversations.layer),
					Layer.provideMerge(composedFrom),
					Layer.provide(workflowsForTests),
				),
			),
		),
	);
};

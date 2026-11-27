import { Effect, Layer, ManagedRuntime } from "effect";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { noComputers } from "../computers/testing.ts";
import type { RunEffect } from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { runOnPostgres, type TestInfrastructure } from "../database/testing.ts";
import { Notifications } from "../notifications/notifications.ts";
import { unimplemented } from "../testing.ts";
import { Lanes } from "../workflows/lanes.ts";
import { AutomationRuns } from "./automations/runs.ts";
import { ChatServices } from "./chat-services.ts";
import {
	turnRequestsForTests,
	turnSignalsForTests,
	turnWorkflowForTests,
} from "./turn-workflow.test-support.ts";
import { turnInternalsForTests } from "./turns/testing.ts";
import { Turns } from "./turns/turns.ts";
import { ChatWorkflows } from "./workflows.ts";

/** Every workflow the cases' lanes hold: core's, and the stand-in for the bot loop's turns. */
const definitions = [...ChatWorkflows.definitions, turnWorkflowForTests];

/**
 * A workflow engine for the Postgres cases. The workflows it starts only hold
 * their lanes: a case runs their steps itself, and frees each lane as the
 * workflow's last step would.
 */
const held = () => DurableDeferred.await(DurableDeferred.make("released"));

const engineForTests = ManagedRuntime.make(
	Layer.mergeAll(Layer.empty, ...definitions.map((definition) => definition.toLayer(held))).pipe(
		Layer.provideMerge(WorkflowEngine.layerMemory),
	),
).runSync(Effect.service(WorkflowEngine.WorkflowEngine));

/** Lanes over the test engine, in the caller's database. */
export const lanesForTests = Lanes.make(definitions).pipe(
	Effect.provideService(WorkflowEngine.WorkflowEngine, engineForTests),
);

/**
 * The `TurnSignals` the chat services signal turns' workflows with when a
 * case gives none, on the test engine, for a case that gives its own but
 * signals turns it runs no workflow for as these would.
 */
export const standInTurnSignals: Turns.TurnSignals.Interface = Effect.runSync(
	Effect.service(Turns.TurnSignals.Service).pipe(
		Effect.provide(
			turnSignalsForTests.pipe(
				Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, engineForTests)),
			),
		),
	),
);

/** The test engine and lanes over it, as the services that start and signal workflows need them. */
const workflowsForTests = Layer.merge(
	Layer.effect(Lanes.Service, lanesForTests),
	Layer.succeed(WorkflowEngine.WorkflowEngine, engineForTests),
);

/**
 * The chat services as the server composes them, on the test database and
 * engine (see `workflowsForTests`), with stream events delivered to `bus`,
 * with what they are composed from and the turn internals a case drives
 * directly (see `turnInternalsForTests`). `signals`, when given, replaces how
 * turns' workflows are signalled.
 */
export const chatServicesLayerForTests = (
	bus: Pick<EventBus.Interface, "publishCommitted">,
	signals?: Turns.TurnSignals.Interface,
) => {
	const composedFrom = Layer.mergeAll(
		signals ? Layer.succeed(Turns.TurnSignals.Service, signals) : turnSignalsForTests,
		turnRequestsForTests,
		AutomationRuns.layer,
	).pipe(
		Layer.provide(workflowsForTests),
		Layer.merge(EventOutbox.layer.pipe(Layer.provide(unimplemented(EventBus.Service, bus)))),
		// Notifying is tested on its own; here it would only send pushes nobody receives.
		Layer.merge(unimplemented(Notifications.Service, { handler: () => Effect.void })),
		// Deleting a bot destroys its computer, which no case here has made.
		Layer.merge(noComputers),
	);
	return turnInternalsForTests.pipe(
		Layer.provideMerge(ChatServices.layer),
		Layer.provideMerge(composedFrom),
		Layer.provide(workflowsForTests),
	);
};

/**
 * {@link chatServicesLayerForTests}, built: a context holding the chat
 * services, what they are composed from, and the turn internals.
 */
export const chatServicesForTests = (
	bus: Pick<EventBus.Interface, "publishCommitted">,
	signals?: Turns.TurnSignals.Interface,
	runOn: RunEffect<TestInfrastructure> = runOnPostgres,
) => {
	const services = chatServicesLayerForTests(bus, signals);
	return runOn(Effect.context<Layer.Success<typeof services>>().pipe(Effect.provide(services)));
};

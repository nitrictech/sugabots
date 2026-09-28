import { Effect, Layer } from "effect";
import type { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { runOnPostgres } from "../database/testing.ts";
import { workflowsForTests } from "../workflows/testing.ts";
import { Conversations } from "./conversations.ts";
import { RoutineRuns } from "./routines/runs.ts";
import { TurnRequests } from "./turns/requests.ts";
import { TurnSignals } from "./turns/signals.ts";

/**
 * The conversation services as the server composes them, on the test
 * database and engine (see `workflowsForTests`), with stream events delivered
 * to `bus`: a context holding them and what they are composed from.
 * `signals`, when given, replaces how turns' workflows are signalled.
 */
export const conversationsForTests = (
	bus: Pick<EventBus, "publishCommitted">,
	signals?: TurnSignals.Interface,
) => {
	const composedFrom = Layer.mergeAll(
		TurnRequests.layer,
		signals ? Layer.succeed(TurnSignals.Service, signals) : TurnSignals.layer,
		RoutineRuns.layer,
	).pipe(Layer.provide(workflowsForTests), Layer.merge(EventOutbox.layer(bus)));
	return runOnPostgres(
		Effect.context<Conversations.Services | Layer.Success<typeof composedFrom>>().pipe(
			Effect.provide(Conversations.layer.pipe(Layer.provideMerge(composedFrom))),
		),
	);
};

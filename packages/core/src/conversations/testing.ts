import { Effect, Layer } from "effect";
import type { EventBus } from "../database/events/bus.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { runOnPostgres } from "../database/testing.ts";
import { workflowsForTests } from "../workflows/testing.ts";
import { composeConversations } from "./composition.ts";
import { RoutineRuns } from "./routines/runs.ts";
import { TurnRequests } from "./turns/requests.ts";
import { TurnSignals } from "./turns/signals.ts";

/**
 * The services the conversations are composed from, over the test engine
 * (see `workflowsForTests`), with stream events delivered to `bus`.
 */
export const conversationServicesForTests = (bus: Pick<EventBus, "publishCommitted">) =>
	Layer.mergeAll(TurnRequests.layer, TurnSignals.layer, RoutineRuns.layer).pipe(
		Layer.provide(workflowsForTests),
		Layer.merge(EventOutbox.layer(bus)),
	);

/**
 * The conversations as the server composes them, on the test database and
 * engine. `signals`, when given, replaces how turns' workflows are signalled.
 */
export const conversationsForTests = (
	bus: Pick<EventBus, "publishCommitted">,
	signals?: TurnSignals.Interface,
) =>
	runOnPostgres(
		composeConversations.pipe(
			signals ? Effect.provideService(TurnSignals.Service, signals) : (composing) => composing,
			Effect.provide(conversationServicesForTests(bus)),
		),
	);

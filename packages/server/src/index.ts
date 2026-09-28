import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { composeConversations } from "@sugabots/core/conversations/composition";
import { Routine, routineWorkflow } from "@sugabots/core/conversations/routines/routine.workflow";
import { RoutineRuns } from "@sugabots/core/conversations/routines/runs";
import { stepsLayer as routineSteps } from "@sugabots/core/conversations/routines/steps";
import { stepsLayer as summarySteps } from "@sugabots/core/conversations/summaries/summary.steps";
import { Summary, summaryWorkflow } from "@sugabots/core/conversations/summaries/summary.workflow";
import { builtInTools as builtInToolsFor } from "@sugabots/core/conversations/tools/built-in";
import { connectionTools as connectionToolsFor } from "@sugabots/core/conversations/tools/connections";
import { pageFetcher } from "@sugabots/core/conversations/tools/web-fetch/fetch-page";
import {
	Facilitate,
	facilitateWorkflow,
} from "@sugabots/core/conversations/turns/facilitate.workflow";
import { stepsLayer as facilitateSteps } from "@sugabots/core/conversations/turns/facilitator";
import { Models, modelProbeLayer, modelsLayer } from "@sugabots/core/conversations/turns/model";
import { TurnRequests } from "@sugabots/core/conversations/turns/requests";
import { TurnSignals } from "@sugabots/core/conversations/turns/signals";
import { stepsLayer as turnSteps } from "@sugabots/core/conversations/turns/turn.steps";
import { Turn, turnWorkflow } from "@sugabots/core/conversations/turns/turn.workflow";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer } from "@sugabots/core/database/database";
import { createEventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { postgresEventRelay } from "@sugabots/core/database/events/relay";
import { postgresEventStore } from "@sugabots/core/database/events/store";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { ConnectionRepository } from "@sugabots/core/providers/connections/connection-repository";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { ConnectionSignIn } from "@sugabots/core/providers/connections/connection-sign-in";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { seedEveryWorkspaceLayer } from "@sugabots/core/providers/model-providers/preset-seeding";
import { Egress } from "@sugabots/core/providers/network/egress";
import { SearchProviderRepository } from "@sugabots/core/providers/search-providers/search-provider-repository";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { authorization } from "@sugabots/core/workspaces/access";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { Config, Duration, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Authentication } from "./auth/authentication.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { requestSpanNames } from "./http/tracing.ts";
import { observabilityLayer } from "./observability.ts";
import { channelAccess } from "./routes/events/access.ts";
import { backgroundLayer } from "./runtime.ts";
import { VERSION } from "./version.ts";
import { Workflows } from "./workflows.ts";

/**
 * How long a client gets to finish what it was sent before its socket is cut.
 *
 * Past this the process is holding the port and, in development, the watcher
 * cannot restart. A request still running here was going to be abandoned by
 * the restart anyway.
 */
const SHUTDOWN_GRACE = Duration.seconds(3);

/** The process: builds every part of the API and binds a port. */
const main = Effect.gen(function* () {
	const installation = yield* Installation.Service;

	const authentication = yield* Authentication.Service;

	const eventStore = yield* postgresEventStore;
	// Every process runs a worker, so what one writes the others must hear about.
	const bus = createEventBus({ store: eventStore, relay: yield* postgresEventRelay(eventStore) });

	const egress = yield* Egress.Service;
	const httpClients = egress.providers;

	// One model client for turns, summaries, facilitation, trials and settings.
	const model = yield* Models;
	// What the conversations are composed from: how they start and signal durable
	// workflows, on the engine WORKFLOW_ENGINE names, and where their stream
	// events are recorded.
	const conversationServices = yield* Layer.build(
		Layer.mergeAll(TurnRequests.layer, TurnSignals.layer, RoutineRuns.layer).pipe(
			Layer.provideMerge(Lanes.layer([Summary, Turn, Facilitate, Routine])),
			Layer.provideMerge(Workflows.engine),
			Layer.merge(EventOutbox.layer(bus)),
		),
	);
	const conversations = yield* composeConversations.pipe(Effect.provide(conversationServices));
	const stores = conversations.stores;
	// A search goes to the workspace's own provider, so its client is bound to
	// that address like a model provider's.
	const builtInTools = builtInToolsFor({
		fetchPage: pageFetcher({ fetch: egress.webFetch }),
		searchProviders: yield* SearchProviderRepository.Service,
		httpClients,
	});

	// A connection's session is bound to its own address the same way. One signed
	// in with OAuth carries the tokens its row holds.
	const connectionTools = connectionToolsFor({
		connections: yield* ConnectionRepository.Service,
		httpClients,
		oauth: { clients: (yield* ConnectionSignIn.Service).clients, fetch: egress.oauth },
	});

	// Summaries, turns, facilitation and routine runs are workflows.
	yield* Layer.build(
		Layer.mergeAll(
			summaryWorkflow.layer,
			turnWorkflow.layer,
			facilitateWorkflow.layer,
			routineWorkflow.layer,
			Lanes.reconcileLayer,
		).pipe(
			Layer.provideMerge(summarySteps({ store: stores.summaries, model })),
			Layer.provideMerge(
				routineSteps({ routines: stores.routines, settlement: conversations.settlement }),
			),
			Layer.provideMerge(facilitateSteps({ model, emit: conversations.emit })),
			Layer.provideMerge(
				turnSteps({
					execution: stores.turns,
					turns: conversations.repositories.turns,
					toolCalls: conversations.repositories.toolCalls,
					model,
					events: bus,
					collaborations: stores.collaborations,
					approvals: stores.approvals,
					builtInTools,
					connectionTools,
					emit: conversations.emit,
				}),
			),
			Layer.provide(Layer.succeedContext(conversationServices)),
		),
	);

	yield* Layer.build(seedEveryWorkspaceLayer);
	yield* Layer.build(backgroundLayer({ eventStore, routines: stores.routines }));
	const api = apiLayer({
		authentication,
		installation,
		authorization,
		stores,
		events: { bus, access: channelAccess(authorization, stores.threads) },
		model,
	});
	const server = yield* Layer.build(
		HttpRouter.serve(Layer.merge(api, webAppLayer), { disableListenLog: true }).pipe(
			Layer.provide(requestSpanNames),
			Layer.provideMerge(
				NodeHttpServer.layerConfig(createServer, {
					port: Config.Port("PORT").pipe(Config.withDefault(3000)),
					gracefulShutdownTimeout: Config.succeed(SHUTDOWN_GRACE),
				}),
			),
		),
	);
	// Added after the server so the event streams end before it closes. Each one
	// holds a socket open for as long as its browser is there, and closing the
	// server first would wait on clients that never hang up.
	yield* Effect.addFinalizer(() => Effect.promise(() => bus.close()));
	yield* HttpServer.addressFormattedWith((address) =>
		Effect.sync(() => console.log(`sugabots ${VERSION} listening on ${address}`)),
	).pipe(Effect.provide(server));
	return yield* Effect.never;
});

/**
 * What the process owns once and every service below builds on. A service's
 * `layer` provides the services it is built from, but never these, so there
 * is one pool, one cipher and one egress policy however many services use
 * them.
 */
const infrastructure = Layer.mergeAll(
	databaseLayer,
	Ids.layer,
	Credentials.layer,
	Installation.layer,
	Egress.layer,
	Email.layer,
	Accounts.layer,
);

main.pipe(
	Effect.scoped,
	// The tracer goes in with the database so that everything is traced: routes,
	// better-auth's hooks, the background loops, and the statements they all send.
	Effect.provide(
		Layer.mergeAll(
			Authentication.layer,
			Membership.layer,
			Onboarding.layer,
			PodAdministration.layer,
			AgentAdministration.layer,
			ModelProviderSetup.layer,
			SearchProviderSetup.layer,
			ConnectionSetup.layer,
		).pipe(
			// Settings try a model through the model client turns use.
			Layer.provideMerge(modelProbeLayer),
			Layer.provideMerge(modelsLayer),
			Layer.provideMerge(
				Layer.mergeAll(
					ModelProviderRepository.layer,
					SearchProviderRepository.layer,
					ConnectionRepository.layer,
					ConnectionSignIn.layer,
				),
			),
			Layer.provideMerge(infrastructure),
			Layer.provideMerge(observabilityLayer),
		),
	),
	NodeRuntime.runMain,
);

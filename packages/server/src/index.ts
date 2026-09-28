import { NodeRuntime } from "@effect/platform-node";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { stepsLayer as compactionSteps } from "@sugabots/core/conversations/compaction/compaction.steps";
import {
	Compaction,
	compactionWorkflow,
} from "@sugabots/core/conversations/compaction/compaction.workflow";
import { Conversations } from "@sugabots/core/conversations/conversations";
import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { RoutineRuns } from "@sugabots/core/conversations/routines/runs";
import { routineSchedulerLayer } from "@sugabots/core/conversations/routines/scheduler";
import { BuiltInTools } from "@sugabots/core/conversations/tools/built-in";
import { ConnectionTools } from "@sugabots/core/conversations/tools/connections";
import { modelProbeLayer, modelsLayer } from "@sugabots/core/conversations/turns/model";
import { TurnRequests } from "@sugabots/core/conversations/turns/requests";
import { TurnSignals } from "@sugabots/core/conversations/turns/signals";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventPruning } from "@sugabots/core/database/events/prune";
import { EventStore } from "@sugabots/core/database/events/store";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { seedEveryWorkspaceLayer } from "@sugabots/core/providers/model-providers/preset-seeding";
import { Egress } from "@sugabots/core/providers/network/egress";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Authorization } from "@sugabots/core/workspaces/authorization";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { Visibility } from "@sugabots/core/workspaces/visibility";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Authentication } from "./auth/authentication.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { listeningLayer, nodeServerLayer } from "./http/serve.ts";
import { requestSpanNames } from "./http/tracing.ts";
import { observabilityLayer } from "./observability.ts";
import { ChannelAccess } from "./routes/events/access.ts";
import { Workflows } from "./workflows.ts";

/**
 * What the process owns once and every service above builds on: the pool,
 * ids, the cipher, the installation's settings and egress policy, the durable
 * events and the bus that fans them out, and the workflow engine with its
 * lanes. A service's `layer` never provides these, so there is one of each
 * however many services use them.
 */
const Infrastructure = Layer.mergeAll(
	Ids.layer,
	Credentials.layer,
	Egress.layer,
	EventOutbox.layer,
	Workflows.lanes,
).pipe(
	Layer.provideMerge(Layer.mergeAll(Installation.layer, EventBus.layer, Workflows.engine)),
	Layer.provideMerge(EventStore.layer),
	Layer.provideMerge(databaseLayer),
);

/** The outside systems: email, the workspaces' models, and the tools turns are offered. */
const Integrations = Layer.mergeAll(
	Email.layer,
	modelsLayer,
	modelProbeLayer,
	BuiltInTools.layer,
	ConnectionTools.layer,
);

/** Who may do what, which the use cases ask and the event streams ask directly. */
const Authorizing = Layer.mergeAll(Authorization.layer, Visibility.layer);

/** Accounts, members, pods, agents and the providers they use, and trying a model. */
const WorkspacesAndProviders = Layer.mergeAll(
	Membership.layer,
	Onboarding.layer,
	PodAdministration.layer,
	AgentAdministration.layer,
	ModelProviderSetup.layer,
	SearchProviderSetup.layer,
	ConnectionSetup.layer,
	ModelTrials.layer,
).pipe(Layer.provideMerge(Accounts.layer));

/**
 * The conversations, over how they start and signal their workflows. Their
 * events go through the outbox.
 */
const ConversationServices = Conversations.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(TurnRequests.layer, TurnSignals.layer, RoutineRuns.layer)),
);

	// One model client for turns, summaries, compactions, facilitation, trials and settings.
	const model = yield* Models;
	// The conversations, over what they are composed from: how they start and
	// signal durable workflows, on the engine WORKFLOW_ENGINE names, and where
	// their stream events are recorded.
	const conversations = yield* Layer.build(
		Conversations.layer.pipe(
			Layer.provideMerge(Layer.mergeAll(TurnRequests.layer, TurnSignals.layer, RoutineRuns.layer)),
			Layer.provideMerge(Lanes.layer([Summary, Compaction, Turn, Facilitate, Routine])),
			Layer.provideMerge(Workflows.engine),
			Layer.provideMerge(EventOutbox.layer(bus)),
		),
	);
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
			compactionWorkflow.layer,
			turnWorkflow.layer,
			facilitateWorkflow.layer,
			routineWorkflow.layer,
			Lanes.reconcileLayer,
		).pipe(
			Layer.provideMerge(summarySteps({ model })),
			Layer.provideMerge(compactionSteps({ model })),
			Layer.provideMerge(routineSteps),
			Layer.provideMerge(facilitateSteps({ model })),
			Layer.provideMerge(turnSteps({ model, events: bus, builtInTools, connectionTools })),
			Layer.provide(Layer.succeedContext(conversations)),
		),
	);

	yield* Layer.build(seedEveryWorkspaceLayer);
	yield* Layer.build(
		backgroundLayer(eventStore).pipe(Layer.provide(Layer.succeedContext(conversations))),
	);
	const api = apiLayer({
		authentication,
		installation,
		events: {
			bus,
			access: channelAccess(yield* Authorization.Service, yield* Visibility.Service),
		},
	}).pipe(Layer.provide(Layer.succeedContext(conversations)));
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
 * What runs without a request: the workflows, the routine scheduler, the
 * nightly event prune, and seeding the preset providers into every workspace.
 */
const Background = Layer.mergeAll(
	Workflows.layer,
	routineSchedulerLayer,
	EventPruning.layer,
	seedEveryWorkspaceLayer,
);

/** The API and the web app on `PORT`, with better-auth answering who is calling. */
const Http = listeningLayer.pipe(
	Layer.provideMerge(
		HttpRouter.serve(Layer.merge(apiLayer, webAppLayer), { disableListenLog: true }),
	),
	Layer.provide([Authentication.layer, ChannelAccess.layer, requestSpanNames]),
	Layer.provide(nodeServerLayer),
);

/**
 * The process, tier by tier. The tracer goes in at the bottom so that
 * everything is traced: routes, better-auth's hooks, the background work, and
 * the statements they all send.
 */
const Main = Layer.mergeAll(Http, Background).pipe(
	Layer.provide(ConversationServices),
	Layer.provide(WorkspacesAndProviders),
	Layer.provide(Authorizing),
	Layer.provide(Integrations),
	Layer.provide(Infrastructure),
	Layer.provide(observabilityLayer),
);

Layer.launch(Main).pipe(NodeRuntime.runMain);

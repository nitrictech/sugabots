import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { chatStore } from "@sugabots/core/conversations/chats/store";
import { routineStore } from "@sugabots/core/conversations/routines/store";
import { queueSummary, summaryStore } from "@sugabots/core/conversations/summaries/store";
import { Summary, summary } from "@sugabots/core/conversations/summaries/summary.workflow";
import { stepsLayer as summarySteps } from "@sugabots/core/conversations/summaries/worker";
import { threadStore } from "@sugabots/core/conversations/threads/store";
import { toolApprovalStore } from "@sugabots/core/conversations/tools/approvals/store";
import { builtInTools as builtInToolsFor } from "@sugabots/core/conversations/tools/built-in";
import { toolCallStore } from "@sugabots/core/conversations/tools/calls/store";
import { collaborationStore } from "@sugabots/core/conversations/tools/collaborate/store";
import { connectionTools as connectionToolsFor } from "@sugabots/core/conversations/tools/connections";
import { pageFetcher } from "@sugabots/core/conversations/tools/web-fetch/fetch-page";
import { workspaceTurnModel } from "@sugabots/core/conversations/turns/model";
import { queueTurnAsJob } from "@sugabots/core/conversations/turns/queue";
import { turnSignals } from "@sugabots/core/conversations/turns/signals";
import { turnStore } from "@sugabots/core/conversations/turns/store";
import { Turn, turnWorkflow } from "@sugabots/core/conversations/turns/turn.workflow";
import { stepsLayer as turnSteps } from "@sugabots/core/conversations/turns/worker";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { type Database, layer as databaseLayer } from "@sugabots/core/database/database";
import { createEventBus } from "@sugabots/core/database/events/bus";
import { eventPublisher } from "@sugabots/core/database/events/publish";
import { postgresEventRelay } from "@sugabots/core/database/events/relay";
import { postgresEventStore } from "@sugabots/core/database/events/store";
import { Installation } from "@sugabots/core/installation/installation";
import { oauthProviders } from "@sugabots/core/providers/connections/oauth";
import { connectionStore } from "@sugabots/core/providers/connections/store";
import { modelProviderStore } from "@sugabots/core/providers/model-providers/store";
import { Egress } from "@sugabots/core/providers/network/egress";
import { searchProviderStore } from "@sugabots/core/providers/search-providers/store";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { authorization } from "@sugabots/core/workspaces/access";
import { agentStore } from "@sugabots/core/workspaces/agents/store";
import { systemAgentStore } from "@sugabots/core/workspaces/agents/system-agent-store";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { onboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import { podStore } from "@sugabots/core/workspaces/pods/store";
import { Config, Context, Duration, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { WorkflowEngine } from "effect/unstable/workflow";
import { Authentication } from "./auth/authentication.ts";
import { API_BASE_PATH } from "./http/api.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { requestSpanNames } from "./http/tracing.ts";
import { observabilityLayer } from "./observability.ts";
import { channelAccess } from "./routes/events/access.ts";
import { backgroundLayer } from "./runtime.ts";
import { VERSION } from "./version.ts";
import { Workflows } from "./workflows.ts";

/**
 * The process. Builds every part of the API and binds a port. This is the only
 * file that knows how the parts fit.
 */

/**
 * How long a client gets to finish what it was sent before its socket is cut.
 *
 * Past this the process is holding the port and, in development, the watcher
 * cannot restart. A request still running here was going to be abandoned by
 * the restart anyway.
 */
const SHUTDOWN_GRACE = Duration.seconds(3);

const main = Effect.gen(function* () {
	const database = yield* Effect.context<Database>();
	const installation = yield* Installation.Service;

	const authentication = yield* Authentication.Service;
	const membership = yield* Membership.Service;

	const eventStore = yield* postgresEventStore;
	// Every process runs a worker, so what one writes the others must hear about.
	const bus = createEventBus({ store: eventStore, relay: yield* postgresEventRelay(eventStore) });
	const publishEvents = eventPublisher(bus);

	const egress = yield* Egress.Service;
	const httpClients = egress.providers;

	const credentials = yield* Credentials.Service;
	const modelProviders = modelProviderStore(credentials);
	// One model client for turns, system agents, trials, and chat routing.
	const model = workspaceTurnModel({ modelProviders, httpClients });
	// Durable workflows, on the engine WORKFLOW_ENGINE names. The engine and
	// lanes come first, because the stores start and wake workflows.
	const engine = yield* Layer.build(
		Lanes.layer([Summary, Turn]).pipe(Layer.provideMerge(Workflows.engine)),
	);
	const lanes = Context.get(engine, Lanes.Service);
	const signals = turnSignals(Context.get(engine, WorkflowEngine.WorkflowEngine));
	const stores = {
		pods: podStore,
		agents: agentStore,
		systemAgents: systemAgentStore,
		onboarding: onboardingStore,
		modelProviders,
		searchProviders: searchProviderStore(credentials),
		connections: connectionStore(credentials),
		chats: chatStore(publishEvents, queueTurnAsJob),
		routines: routineStore(publishEvents, queueTurnAsJob),
		threads: threadStore(),
		turns: turnStore(publishEvents, queueTurnAsJob, signals),
		summaries: summaryStore(publishEvents),
		collaborations: collaborationStore(publishEvents, queueTurnAsJob),
		calls: toolCallStore(publishEvents),
		approvals: toolApprovalStore(publishEvents, signals),
	};
	// A search goes to the workspace's own provider, so its client is bound to
	// that address like a model provider's.
	const builtInTools = builtInToolsFor({
		fetchPage: pageFetcher({ fetch: egress.webFetch }),
		searchProviders: stores.searchProviders,
		httpClients,
	});

	// A connection's session is bound to its own address the same way. One signed
	// in with OAuth carries the tokens its row holds.
	const connectionTools = connectionToolsFor({
		connections: stores.connections,
		httpClients,
		oauth: {
			providers: oauthProviders({
				connections: stores.connections,
				run: Effect.runPromiseWith(database),
				redirectUrl: `${installation.publicUrl}${API_BASE_PATH}/connections/oauth/callback`,
			}),
			fetch: egress.oauth,
		},
	});

	// Summaries are the first workflows to move from the job queue; turns are
	// registered but still run as jobs until the code that starts them moves over.
	yield* Layer.build(
		Layer.mergeAll(Summary.toLayer(summary), Turn.toLayer(turnWorkflow), Lanes.reconcileLayer).pipe(
			Layer.provideMerge(summarySteps({ store: stores.summaries, model })),
			Layer.provideMerge(
				turnSteps({
					store: stores.turns,
					model,
					events: bus,
					collaborations: stores.collaborations,
					calls: stores.calls,
					approvals: stores.approvals,
					builtInTools,
					connectionTools,
					routines: stores.routines,
					queueSummary: (request) => queueSummary(lanes, request),
				}),
			),
			Layer.provide(Layer.succeedContext(engine)),
		),
	);

	yield* Layer.build(
		backgroundLayer({
			eventStore,
			bus,
			model,
			turns: stores.turns,
			queueSummary: (request) => queueSummary(lanes, request),
			routines: stores.routines,
			collaborations: stores.collaborations,
			calls: stores.calls,
			approvals: stores.approvals,
			builtInTools,
			connectionTools,
			publishEvents,
		}),
	);
	const api = apiLayer({
		authentication,
		installation,
		oauthFetch: egress.oauth,
		authorization,
		membership,
		stores,
		events: { bus, access: channelAccess(authorization, stores.threads) },
		httpClients,
		validateProviderUrl: egress.validateProviderUrl,
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

main.pipe(
	Effect.scoped,
	// The tracer goes in with the database so that everything is traced: routes,
	// better-auth's hooks, the background loops, and the statements they all send.
	Effect.provide(
		Layer.mergeAll(
			databaseLayer,
			Credentials.layer,
			Installation.layer,
			Egress.layer,
			Authentication.layer,
			Membership.layer,
		).pipe(Layer.provideMerge(observabilityLayer)),
	),
	NodeRuntime.runMain,
);

import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { chatStore } from "@sugabots/core/conversations/chats/store";
import { routineStore } from "@sugabots/core/conversations/routines/store";
import { summaryStore } from "@sugabots/core/conversations/summaries/store";
import { threadStore } from "@sugabots/core/conversations/threads/store";
import { toolApprovalStore } from "@sugabots/core/conversations/tools/approvals/store";
import { builtInTools as builtInToolsFor } from "@sugabots/core/conversations/tools/built-in";
import { toolCallStore } from "@sugabots/core/conversations/tools/calls/store";
import { collaborationStore } from "@sugabots/core/conversations/tools/collaborate/store";
import { connectionTools as connectionToolsFor } from "@sugabots/core/conversations/tools/connections";
import { pageFetcher } from "@sugabots/core/conversations/tools/web-fetch/fetch-page";
import { workspaceTurnModel } from "@sugabots/core/conversations/turns/model";
import { turnStore } from "@sugabots/core/conversations/turns/store";
import {
	type Database,
	layer as databaseLayer,
	effectRunner,
} from "@sugabots/core/database/database";
import { createEventBus } from "@sugabots/core/database/events/bus";
import { eventPublisher } from "@sugabots/core/database/events/publish";
import { postgresEventRelay } from "@sugabots/core/database/events/relay";
import { postgresEventStore } from "@sugabots/core/database/events/store";
import { EmailService } from "@sugabots/core/email/email";
import { emailLayer } from "@sugabots/core/email/layer";
import { oauthProviders } from "@sugabots/core/providers/connections/oauth";
import { connectionStore } from "@sugabots/core/providers/connections/store";
import { aesCredentialCipher } from "@sugabots/core/providers/model-providers/credentials";
import { modelProviderStore } from "@sugabots/core/providers/model-providers/store";
import {
	createEgressHttpClient,
	createEgressHttpClients,
	createEgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import { searchProviderStore } from "@sugabots/core/providers/search-providers/store";
import { authorization } from "@sugabots/core/workspaces/access";
import { agentStore } from "@sugabots/core/workspaces/agents/store";
import { systemAgentStore } from "@sugabots/core/workspaces/agents/system-agent-store";
import { onboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import { podStore } from "@sugabots/core/workspaces/pods/store";
import { drizzle } from "drizzle-orm/node-postgres";
import { Duration, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Pool } from "pg";
import { createAuth } from "./auth/auth.ts";
import { API_BASE_PATH, configFromEnv } from "./config.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { observabilityLayer } from "./observability.ts";
import { channelAccess } from "./routes/events/access.ts";
import { backgroundLayer } from "./runtime.ts";
import { VERSION } from "./version.ts";

/**
 * The process. Reads the environment once, builds every part of the API from
 * it, and binds a port. This is the only file that knows how the parts fit.
 */

const config = configFromEnv();
const {
	port,
	baseUrl,
	webOrigins,
	secret,
	allowPrivateModelProviderNetwork,
	allowPrivateWebFetchNetwork,
	allowOpenSignUp,
	requireEmailVerification,
} = config;

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
	const run = effectRunner({ runPromiseExit: Effect.runPromiseExitWith(database) });
	const emailService = yield* EmailService;

	// better-auth's drizzle adapter only speaks node-postgres, so it keeps a pool
	// of its own until it can be ported onto the database's.
	const authPool = yield* Effect.acquireRelease(
		Effect.sync(() => new Pool({ connectionString: config.databaseUrl })),
		(pool) => Effect.promise(() => pool.end()),
	);
	const auth = createAuth({
		db: drizzle({ client: authPool }),
		run,
		secret,
		baseUrl,
		webOrigins,
		mailer: (email) => Effect.runPromiseWith(database)(emailService.send(email)),
		emailFrom: config.emailFrom,
		allowOpenSignUp,
		requireEmailVerification,
	});

	const eventStore = yield* postgresEventStore;
	// Every process runs a worker, so what one writes the others must hear about.
	const bus = createEventBus({ store: eventStore, relay: yield* postgresEventRelay(eventStore) });
	const publishEvents = eventPublisher(bus);

	const httpClients = yield* acquireClosable(() =>
		createEgressHttpClients({ allowPrivateNetwork: allowPrivateModelProviderNetwork }),
	);
	const validateProviderUrl = createEgressUrlValidator({
		allowPrivateNetwork: allowPrivateModelProviderNetwork,
	});
	// A sign-in goes where the server's authorization server says: its well-known
	// documents, then often another host. So that client is unbound, under the
	// same policy as the providers'.
	const oauthClient = yield* acquireClosable(() =>
		createEgressHttpClient({ allowPrivateNetwork: allowPrivateModelProviderNetwork }),
	);
	// Pages may be anywhere, so the tool's client is unbound, under its own policy.
	const webFetchClient = yield* acquireClosable(() =>
		createEgressHttpClient({ allowPrivateNetwork: allowPrivateWebFetchNetwork }),
	);

	// One server key seals every stored credential, model and search alike.
	const credentialCipher = aesCredentialCipher(config.modelProviderEncryptionKey);
	const modelProviders = modelProviderStore(credentialCipher);
	// One model client for turns, system agents, trials, and chat routing.
	const model = workspaceTurnModel({ modelProviders, httpClients });
	const stores = {
		pods: podStore,
		agents: agentStore,
		systemAgents: systemAgentStore,
		onboarding: onboardingStore,
		modelProviders,
		searchProviders: searchProviderStore(credentialCipher),
		connections: connectionStore(credentialCipher),
		chats: chatStore(publishEvents),
		routines: routineStore(publishEvents),
		threads: threadStore(),
		turns: turnStore(publishEvents),
		summaries: summaryStore(publishEvents),
		collaborations: collaborationStore(publishEvents),
		calls: toolCallStore(publishEvents),
		approvals: toolApprovalStore(publishEvents),
	};
	// A search goes to the workspace's own provider, so its client is bound to
	// that address like a model provider's.
	const builtInTools = builtInToolsFor({
		fetchPage: pageFetcher({ fetch: webFetchClient }),
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
				redirectUrl: `${baseUrl.replace(/\/$/, "")}${API_BASE_PATH}/connections/oauth/callback`,
			}),
			fetch: oauthClient,
		},
	});

	yield* Layer.build(
		backgroundLayer({
			eventStore,
			bus,
			model,
			turns: stores.turns,
			summaries: stores.summaries,
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
		auth,
		webOrigins,
		baseUrl,
		oauthFetch: oauthClient,
		authorization,
		stores,
		events: { bus, access: channelAccess(authorization, stores.threads) },
		httpClients,
		validateProviderUrl,
		model,
	});
	yield* Layer.build(
		HttpRouter.serve(Layer.merge(api, webAppLayer), { disableListenLog: true }).pipe(
			Layer.provide(
				NodeHttpServer.layer(createServer, { port, gracefulShutdownTimeout: SHUTDOWN_GRACE }),
			),
		),
	);
	// Added after the server so the event streams end before it closes. Each one
	// holds a socket open for as long as its browser is there, and closing the
	// server first would wait on clients that never hang up.
	yield* Effect.addFinalizer(() => Effect.promise(() => bus.close()));
	console.log(`sugabots ${VERSION} listening on http://localhost:${port}`);
	return yield* Effect.never;
});

main.pipe(
	Effect.scoped,
	// The tracer goes in with the database so that everything is traced: routes,
	// better-auth's hooks, the background loops, and the statements they all send.
	Effect.provide(
		Layer.merge(databaseLayer(config.databaseUrl), emailLayer(config.email)).pipe(
			Layer.provideMerge(observabilityLayer),
		),
	),
	NodeRuntime.runMain,
);

function acquireClosable<A extends { close(): Promise<void> }>(make: () => A) {
	return Effect.acquireRelease(Effect.sync(make), (resource) =>
		Effect.promise(() => resource.close()),
	);
}

import type { Server } from "node:http";
import { serve } from "@hono/node-server";
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
import { effectRunner } from "@sugabots/core/database/database";
import { createEventBus } from "@sugabots/core/database/events/bus";
import { eventPublisher } from "@sugabots/core/database/events/publish";
import { postgresEventRelay } from "@sugabots/core/database/events/relay";
import { postgresEventStore } from "@sugabots/core/database/events/store";
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
import { Pool } from "pg";
import { createAuth } from "./auth/auth.ts";
import { API_BASE_PATH, configFromEnv } from "./config.ts";
import { createApp } from "./http/app.ts";
import { mount } from "./http/mount.ts";
import { channelAccess } from "./routes/events/access.ts";
import { makeRuntime } from "./runtime.ts";
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
	mailer,
} = config;

// One pool, shared with better-auth, which needs a plain drizzle handle.
const pool = new Pool({ connectionString: config.databaseUrl });
const db = drizzle({ client: pool });
const auth = createAuth({
	db,
	secret,
	baseUrl,
	webOrigins,
	mailer,
	allowOpenSignUp,
	requireEmailVerification,
});

const eventStore = postgresEventStore(db);
// Every process runs a worker, so what one writes the others must hear about.
const bus = createEventBus({ store: eventStore, relay: postgresEventRelay(pool, eventStore) });
const publishEvents = eventPublisher(bus);

const httpClients = createEgressHttpClients({
	allowPrivateNetwork: allowPrivateModelProviderNetwork,
});
const validateProviderUrl = createEgressUrlValidator({
	allowPrivateNetwork: allowPrivateModelProviderNetwork,
});
// A sign-in goes where the server's authorization server says: its well-known
// documents, then often another host. So that client is unbound, under the
// same policy as the providers'.
const oauthClient = createEgressHttpClient({
	allowPrivateNetwork: allowPrivateModelProviderNetwork,
});
// Pages may be anywhere, so the tool's client is unbound, under its own policy.
const webFetchClient = createEgressHttpClient({ allowPrivateNetwork: allowPrivateWebFetchNetwork });

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
			run: (effect) => runtime.runPromise(effect),
			redirectUrl: `${baseUrl.replace(/\/$/, "")}${API_BASE_PATH}/connections/oauth/callback`,
		}),
		fetch: oauthClient,
	},
});

const runtime = makeRuntime({
	pool,
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
	openTelemetryEnv: config.openTelemetryEnv,
});
const run = effectRunner(runtime);

const app = createApp({
	auth,
	webOrigins,
	baseUrl,
	oauthFetch: oauthClient,
	authorization,
	run,
	stores,
	events: { bus, access: channelAccess(authorization, stores.threads, run) },
	httpClients,
	validateProviderUrl,
	model,
});

// Builds the layer now, so a process that cannot start dies here rather than
// answering 500 to whoever arrives first.
await runtime.context();

const http = mount(app);

const server = serve({ fetch: http.fetch, port }, ({ port: bound }) => {
	console.log(`sugabots ${VERSION} listening on http://localhost:${bound}`);
});

/**
 * How long a client gets to finish what it was sent before its socket is cut.
 *
 * Past this the process is holding the port and, in development, the watcher
 * cannot restart. A request still running here was going to be abandoned by
 * the restart anyway.
 */
const SHUTDOWN_GRACE_MS = 3_000;

let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	// Ends the event streams before closing the server, since each one holds a
	// socket open for as long as its browser is there. Closing the server first
	// would wait on clients that never hang up.
	await bus.close();
	await closeServer();
	await runtime.dispose();
	await httpClients.close();
	await webFetchClient.close();
	await oauthClient.close();
}

function closeServer(): Promise<void> {
	// `serve` is typed as either an HTTP/1 or an HTTP/2 server, and only the
	// former has the connection controls. Given no `createServer` it is the
	// former, so these are there; asking is cheaper than asserting it.
	const sockets = server as Partial<Pick<Server, "closeAllConnections" | "closeIdleConnections">>;
	return new Promise((resolve) => {
		const cut = setTimeout(() => {
			sockets.closeAllConnections?.();
			resolve();
		}, SHUTDOWN_GRACE_MS);
		server.close(() => {
			clearTimeout(cut);
			resolve();
		});
		// Keep-alive sockets with nothing on them would otherwise hold the close
		// open for their full idle timeout.
		sockets.closeIdleConnections?.();
	});
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

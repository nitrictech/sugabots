import type { ChatStore } from "@sugabots/core/conversations/chats/store";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import type { ToolApprovalStore } from "@sugabots/core/conversations/tools/approvals/store";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import type { TurnStore } from "@sugabots/core/conversations/turns/store";
import type { EventBus } from "@sugabots/core/database/events/bus";
import type { ConnectionStore } from "@sugabots/core/providers/connections/store";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type {
	EgressHttpClient,
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import type { SearchProviderStore } from "@sugabots/core/providers/search-providers/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import type { AgentStore } from "@sugabots/core/workspaces/agents/store";
import type { SystemAgentStore } from "@sugabots/core/workspaces/agents/system-agent-store";
import type { OnboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import { workspacePermissions } from "@sugabots/core/workspaces/permissions";
import type { PodStore } from "@sugabots/core/workspaces/pods/store";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Auth } from "../auth/auth.ts";
import type { AuthEnv } from "../auth/middleware.ts";
import { requireCookieOrigin, requireSession } from "../auth/middleware.ts";
import { betterAuthSessionResolver } from "../auth/session.ts";
import { API_BASE_PATH, trustedOrigins, webUrl } from "../config.ts";
import { createAgentRoutes } from "../routes/agents/routes.ts";
import { createChatRoutes } from "../routes/chats/routes.ts";
import { createConnectionRoutes } from "../routes/connections/routes.ts";
import type { ChannelAccess } from "../routes/events/access.ts";
import { createEventRoutes, type StreamOptions } from "../routes/events/routes.ts";
import { createModelProviderRoutes } from "../routes/model-providers/routes.ts";
import { createModelTrialRoutes } from "../routes/model-trials/routes.ts";
import { createOnboardingRoutes } from "../routes/onboarding/routes.ts";
import { createPodRoutes } from "../routes/pods/routes.ts";
import { createRoutineRoutes } from "../routes/routines/routes.ts";
import { createSearchProviderRoutes } from "../routes/search-providers/routes.ts";
import { createSystemAgentRoutes } from "../routes/system-agents/routes.ts";
import { createThreadRoutes } from "../routes/threads/routes.ts";
import { createToolApprovalRoutes } from "../routes/tool-approvals/routes.ts";
import { health } from "../version.ts";
import { requireWorkspace } from "./authorisation.ts";
import { limitJsonBody } from "./body.ts";
import { onError, onNotFound } from "./errors.ts";
import type { RunHandler } from "./handler.ts";
import { requestTracing } from "./tracing.ts";

/**
 * The API, as one chained Hono app.
 *
 * The chain is what `packages/sdk` compiles against: `AppType` below is
 * inferred from it, so a route registered on its own statement would be
 * invisible to every client. better-auth's wildcard is deliberately off the
 * chain, because the client reaches it through better-auth's own SDK.
 *
 * `createApp` takes every dependency explicitly. `createTestApp` in
 * `app.test-support.ts` drives the same route table with fakes.
 */

/** What the route table reads and writes. */
export interface Stores {
	pods: PodStore;
	agents: AgentStore;
	systemAgents: SystemAgentStore;
	onboarding: OnboardingStore;
	modelProviders: ModelProviderStore;
	searchProviders: SearchProviderStore;
	connections: ConnectionStore;
	threads: ThreadStore;
	chats: ChatStore;
	routines: RoutineStore;
	turns: Pick<TurnStore, "requestCancel">;
	approvals: ToolApprovalStore;
}

export interface AppOptions {
	/** better-auth. Mounted under `/auth`, and asked who a token belongs to. */
	auth: Auth;
	/** Browser origins besides `baseUrl`'s that may call the API with a cookie. The first is where links point. */
	webOrigins: string[];
	/** Where a browser reaches the API, without `API_BASE_PATH`. */
	baseUrl: string;
	/** Who may do what in which workspace, pod and agent. */
	authorization: Authorization;
	/** Runs a handler's Effect against the process's database. */
	run: RunHandler;
	stores: Stores;
	/** Where live updates are published, who may listen, and for how long. */
	events: { bus: EventBus; access: ChannelAccess; stream?: StreamOptions };
	/** How a model provider is reached, and which URLs it may be reached at. */
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	/** For a connection's sign-in, which goes wherever its authorization server is. */
	oauthFetch: EgressHttpClient;
	/** Runs a model, for trying one out on a system agent before choosing it. */
	model: TurnModel;
}

export function createApp({
	oauthFetch,
	baseUrl,
	auth,
	webOrigins,
	authorization,
	run: runUntraced,
	stores,
	events,
	httpClients,
	validateProviderUrl,
	model,
}: AppOptions) {
	const tracing = requestTracing(runUntraced);
	const { run } = tracing;
	const resolveSession = betterAuthSessionResolver(auth);
	const origins = trustedOrigins({ baseUrl, webOrigins });
	const apiUrl = `${baseUrl.replace(/\/$/, "")}${API_BASE_PATH}`;

	const app = new Hono<AuthEnv>();

	app.use("*", tracing.middleware);

	// Browser requests carry an HttpOnly session cookie. Bearer clients may also
	// send Authorization, but the token issuance header is not exposed to pages.
	app.use(
		"*",
		cors({
			origin: origins,
			allowHeaders: ["authorization", "content-type", "idempotency-key", "last-event-id"],
			credentials: true,
		}),
	);
	app.use("*", limitJsonBody);
	app.use("*", requireCookieOrigin(origins));
	app.onError(onError);
	app.notFound(onNotFound);

	// Sign-up, sign-in, workspaces and invitations.
	app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

	return (
		app
			.get("/health", (c) => c.json(health()))
			.get("/me", requireSession(resolveSession), (c) => c.json(c.get("session").user))
			// What the caller may do in one workspace, so the web app can decide
			// whether to draw a control at all rather than let it fail. The role is
			// here too, because a settings screen says which one somebody holds.
			.get(
				"/workspaces/:workspaceId/me",
				requireSession(resolveSession),
				requireWorkspace(authorization, run, "workspace.read"),
				(c) => {
					const { actor } = c.get("workspace");
					return c.json({
						role: actor.workspaceRole,
						permissions: workspacePermissions(actor),
					});
				},
			)
			.route(
				"/",
				createEventRoutes({
					resolveSession,
					bus: events.bus,
					access: events.access,
					run,
					stream: events.stream,
				}),
			)
			.route("/", createOnboardingRoutes({ resolveSession, run, onboarding: stores.onboarding }))
			.route(
				"/",
				createPodRoutes({
					resolveSession,
					authorization,
					run,
					pods: stores.pods,
					modelProviders: stores.modelProviders,
				}),
			)
			.route(
				"/",
				createSystemAgentRoutes({
					resolveSession,
					authorization,
					run,
					systemAgents: stores.systemAgents,
					modelProviders: stores.modelProviders,
				}),
			)
			.route("/", createModelTrialRoutes({ resolveSession, authorization, run, model }))
			.route(
				"/",
				createModelProviderRoutes({
					resolveSession,
					authorization,
					run,
					modelProviders: stores.modelProviders,
					httpClients,
					validateProviderUrl,
					model,
				}),
			)
			.route(
				"/",
				createSearchProviderRoutes({
					resolveSession,
					authorization,
					run,
					searchProviders: stores.searchProviders,
					httpClients,
					validateProviderUrl,
				}),
			)
			.route(
				"/",
				createConnectionRoutes({
					resolveSession,
					authorization,
					run,
					connections: stores.connections,
					httpClients,
					validateProviderUrl,
					oauth: {
						redirectUrl: `${apiUrl}/connections/oauth/callback`,
						returnTo: `${webUrl({ baseUrl, webOrigins })}/settings/pods`,
						fetch: oauthFetch,
					},
				}),
			)
			.route(
				"/",
				createAgentRoutes({
					resolveSession,
					authorization,
					run,
					agents: stores.agents,
					modelProviders: stores.modelProviders,
				}),
			)
			.route("/", createChatRoutes({ resolveSession, authorization, run, chats: stores.chats }))
			.route(
				"/",
				createRoutineRoutes({ resolveSession, authorization, run, routines: stores.routines }),
			)
			.route(
				"/",
				createToolApprovalRoutes({
					resolveSession,
					authorization,
					run,
					approvals: stores.approvals,
				}),
			)
			.route(
				"/",
				createThreadRoutes({
					resolveSession,
					authorization,
					run,
					threads: stores.threads,
					turns: stores.turns,
				}),
			)
	);
}

/** What `packages/sdk` imports, as a type, to type every call it makes. */
export type AppType = ReturnType<typeof createApp>;

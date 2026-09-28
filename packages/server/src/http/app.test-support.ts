import type { SessionUser } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { RoutineView } from "@sugabots/core/conversations/routines/routine-view";
import { RoutineWebhooks } from "@sugabots/core/conversations/routines/routine-webhooks";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { ThreadView } from "@sugabots/core/conversations/threads/thread-view";
import { ToolApprovals } from "@sugabots/core/conversations/tools/approvals/tool-approvals";
import { TurnCancellation } from "@sugabots/core/conversations/turns/cancellation";
import { createEventBus, type EventBus } from "@sugabots/core/database/events/bus";
import { memoryEventStore } from "@sugabots/core/database/events/store";
import { noDatabase } from "@sugabots/core/database/testing";
import { Installation } from "@sugabots/core/installation/installation";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { unimplemented } from "@sugabots/core/testing";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type { Authentication } from "../auth/authentication.ts";
import { type ChannelAccess, closedChannelAccess } from "../routes/events/access.ts";
import type { StreamOptions } from "../routes/events/routes.ts";
import { apiLayer } from "./app.ts";
import type { HttpServices } from "./services.ts";

type TestIdentity =
	| { authentication: Authentication.Interface; resolveUser?: never }
	| { authentication?: never; resolveUser: UserResolver };

type TestAppOptions<Provided> = TestIdentity & {
	/** Where the web app is served, when a case needs it apart from the API. */
	webAppUrl?: string;
	events?: { bus?: EventBus; access?: ChannelAccess; stream?: StreamOptions };
	/** The services a case is about, in place of the unimplemented ones. */
	services?: Layer.Layer<Provided>;
};

/** The test API's address. */
export const BASE_URL = "http://localhost:3000";
/** Where the test app's web app is served, a browser origin it trusts besides its own. */
export const WEB_ORIGIN = "http://localhost:5173";

export interface TestApp {
	/** A request to `path` under `API_BASE_PATH`, e.g. `/agents/…`. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** A request as the server receives it, at any path. */
	fetch(request: Request): Promise<Response>;
}

/**
 * The complete route table over fakes that reach nothing and store nothing,
 * so a case supplies only what it is about.
 */
export function createTestApp<Provided extends HttpServices = never>(
	options: TestAppOptions<Provided>,
): TestApp {
	const bus = options.events?.bus ?? createEventBus({ store: memoryEventStore() });
	const routes = apiLayer({
		authentication: options.authentication ?? authenticationForResolver(options.resolveUser),
		installation: Installation.fromUrls({
			isProduction: false,
			publicUrl: BASE_URL,
			webAppUrl: options.webAppUrl ?? WEB_ORIGIN,
		}),
		events: {
			bus,
			access: options.events?.access ?? closedChannelAccess(),
			stream: options.events?.stream,
		},
	}).pipe(
		Layer.provide(Layer.merge(emptyServices, options.services ?? Layer.empty)),
		Layer.provide([noDatabase, HttpServer.layerServices]),
	);
	const { handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
	return {
		request: (path, init) =>
			handler(new Request(new URL(`${API_BASE_PATH}${path}`, BASE_URL), init)),
		fetch: (request) => handler(request),
	};
}

function authenticationForResolver(resolveUser: UserResolver): Authentication.Interface {
	return {
		handler: () => Effect.succeed(new Response(null, { status: 404 })),
		identify: identifyFromResolver(resolveUser),
	};
}

/**
 * Services whose every method dies naming itself, so a case supplies, through
 * `services`, exactly the ones it is about.
 */
const emptyServices: Layer.Layer<HttpServices> = Layer.mergeAll(
	unimplemented(Membership.Service),
	unimplemented(PodAdministration.Service),
	unimplemented(AgentAdministration.Service),
	unimplemented(Onboarding.Service),
	unimplemented(ModelProviderSetup.Service),
	unimplemented(SearchProviderSetup.Service),
	unimplemented(ConnectionSetup.Service),
	unimplemented(ModelTrials.Service),
	unimplemented(Chats.Service),
	unimplemented(ChatView.Service),
	unimplemented(ThreadView.Service),
	unimplemented(TurnCancellation.Service),
	unimplemented(ToolApprovals.Service),
	unimplemented(Routines.Service),
	unimplemented(RoutineView.Service),
	unimplemented(RoutineWebhooks.Service),
);

/** Who a test says holds the credentials in `headers`, so HTTP tests run without a database. */
export type UserResolver = (headers: Headers) => Promise<SessionUser | null>;

/** The `Authentication.identify` a test's resolver stands in for. */
export function identifyFromResolver(resolveUser: UserResolver) {
	return (headers: Headers) =>
		Effect.map(
			Effect.promise(() => resolveUser(headers)),
			(user) => user ?? undefined,
		);
}

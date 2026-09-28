import type { SessionUser } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Usage } from "@sugabots/core/accounting/usage";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { RoutineView } from "@sugabots/core/conversations/routines/routine-view";
import { RoutineWebhooks } from "@sugabots/core/conversations/routines/routine-webhooks";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { ThreadView } from "@sugabots/core/conversations/threads/thread-view";
import { ToolApprovals } from "@sugabots/core/conversations/tools/approvals/tool-approvals";
import { TurnCancellation } from "@sugabots/core/conversations/turns/cancellation";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventStore } from "@sugabots/core/database/events/store";
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
import { Authentication } from "../auth/authentication.ts";
import { closedChannelAccess } from "../routes/events/access.test-support.ts";
import { ChannelAccess } from "../routes/events/access.ts";
import { apiLayer } from "./app.ts";
import type { HttpServices } from "./services.ts";

/** The test API's address. */
export const BASE_URL = "http://localhost:3000";
/** Where the test app's web app is served, a browser origin it trusts besides its own. */
const WEB_ORIGIN = "http://localhost:5173";

export interface TestApp {
	/** A request to `path` under `API_BASE_PATH`, e.g. `/agents/…`. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** A request as the server receives it, at any path. */
	fetch(request: Request): Promise<Response>;
}

/** What a case may replace: the routes' services and what the API is built on. */
type TestServices = HttpServices | Authentication.Service | Installation.Service | EventBus.Service;

/**
 * The complete route table, built by `apiLayer` as the server builds it, over
 * `services` and, for everything else, fakes that reach nothing and store
 * nothing. Nobody is signed in unless `services` says who is, with
 * `identifiedBy`.
 */
export function createTestApp<Provided extends TestServices = never>(
	services?: Layer.Layer<Provided>,
): TestApp {
	const routes = apiLayer.pipe(
		Layer.provide(Layer.merge(fakes, services ?? Layer.empty)),
		Layer.provide([noDatabase, HttpServer.layerServices]),
	);
	const { handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
	return {
		request: (path, init) =>
			handler(new Request(new URL(`${API_BASE_PATH}${path}`, BASE_URL), init)),
		fetch: (request) => handler(request),
	};
}

/** `Authentication` asking `resolveUser` who holds a request's credentials. */
export function identifiedBy(resolveUser: UserResolver): Layer.Layer<Authentication.Service> {
	return Layer.succeed(Authentication.Service, {
		handler: () => Effect.succeed(new Response(null, { status: 404 })),
		identify: identifyFromResolver(resolveUser),
	});
}

/** The test installation, with its web app at `webAppUrl`. */
export function installationWithWebAppAt(webAppUrl: string): Layer.Layer<Installation.Service> {
	return Layer.succeed(
		Installation.Service,
		Installation.fromUrls({ isProduction: false, publicUrl: BASE_URL, webAppUrl }),
	);
}

/**
 * Services whose every method dies naming itself, nobody signed in, no
 * channel open to listen on, and a bus in memory, so a case supplies exactly
 * what it is about.
 */
const fakes: Layer.Layer<TestServices> = Layer.mergeAll(
	unimplemented(Membership.Service),
	unimplemented(PodAdministration.Service),
	unimplemented(AgentAdministration.Service),
	unimplemented(Onboarding.Service),
	unimplemented(ModelProviderSetup.Service),
	unimplemented(SearchProviderSetup.Service),
	unimplemented(ConnectionSetup.Service),
	unimplemented(ModelTrials.Service),
	unimplemented(Usage.Service),
	unimplemented(Chats.Service),
	unimplemented(ChatView.Service),
	unimplemented(ThreadView.Service),
	unimplemented(TurnCancellation.Service),
	unimplemented(ToolApprovals.Service),
	unimplemented(Routines.Service),
	unimplemented(RoutineView.Service),
	unimplemented(RoutineWebhooks.Service),
	Layer.succeed(ChannelAccess.Service, closedChannelAccess),
	identifiedBy(async () => null),
	installationWithWebAppAt(WEB_ORIGIN),
	Layer.sync(EventBus.Service, () => EventBus.inProcess({ store: EventStore.inMemory() })),
);

/** Who a test says holds the credentials in `headers`, so HTTP tests run without a database. */
export type UserResolver = (headers: Headers) => Promise<SessionUser | null>;

/** The `Authentication.identify` a test's resolver stands in for. */
function identifyFromResolver(resolveUser: UserResolver) {
	return (headers: Headers) =>
		Effect.map(
			Effect.promise(() => resolveUser(headers)),
			(user) => user ?? undefined,
		);
}

import type { SignedInPerson } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Usage } from "@sugabots/core/accounting/usage";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { Automations } from "@sugabots/core/chats/automations/automations";
import { ChatDetailsView } from "@sugabots/core/chats/chat-details-view";
import { ChatFiles } from "@sugabots/core/chats/chats/chat-files";
import { ChatView } from "@sugabots/core/chats/chats/chat-view";
import { Chats } from "@sugabots/core/chats/chats/chats";
import { Reactions } from "@sugabots/core/chats/reactions/reactions";
import { DesktopViewer } from "@sugabots/core/chats/tools/browser/viewer";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventStore } from "@sugabots/core/database/events/store";
import { noDatabase } from "@sugabots/core/database/testing";
import { Files } from "@sugabots/core/files/files";
import { FilePages } from "@sugabots/core/files/pages";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { ConnectorSetup } from "@sugabots/core/providers/connectors/connector-setup";
import { GitHubApps } from "@sugabots/core/providers/connectors/github/github-app";
import { GitHubConnectors } from "@sugabots/core/providers/connectors/github/github-connectors";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { unimplemented } from "@sugabots/core/testing";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
import { WorkspaceTimeZone } from "@sugabots/core/workspaces/time-zone/workspace-time-zone";
import { WorkspaceSetup } from "@sugabots/core/workspaces/workspace-setup/workspace-setup";
import { Effect, Layer } from "effect";
import { Cookies, HttpRouter, HttpServer } from "effect/unstable/http";
import { Authentication } from "../auth/authentication.ts";
import { closedStreamAccess } from "../routes/events/access.test-support.ts";
import { StreamAccess } from "../routes/events/access.ts";
import { apiLayer } from "./app.ts";
import type { HttpServices } from "./services.ts";

/** The test API's address. */
export const BASE_URL = "http://localhost:3000";
/** Where the test app's web app is served, a browser origin it trusts besides its own. */
export const WEB_ORIGIN = "http://localhost:5173";

export interface TestApp {
	/** A request to `path` under `API_BASE_PATH`, e.g. `/bots/…`. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** A request as the server receives it, at any path. */
	fetch(request: Request): Promise<Response>;
}

/** What a case may replace: the routes' services and what the API is built on. */
type TestServices =
	| HttpServices
	| Authentication.Service
	| ServerSettings.Service
	| EventBus.Service;

/**
 * The complete route table, built by `apiLayer` as the server builds it, over
 * `services` and, for everything else, fakes that reach nothing and store
 * nothing. Nobody is signed in unless `services` says who is, with
 * `identifiedBy`.
 */
export function createTestApp<Provided extends TestServices = never>(
	services?: Layer.Layer<Provided>,
): TestApp {
	const { handler } = HttpRouter.toWebHandler(testRoutes(services), { disableLogger: true });
	return {
		request: (path, init) =>
			handler(new Request(new URL(`${API_BASE_PATH}${path}`, BASE_URL), init)),
		fetch: (request) => handler(request),
	};
}

/**
 * The route table `createTestApp` drives, for a case that serves it on a real
 * port, such as one about WebSockets.
 */
export function testRoutes<Provided extends TestServices = never>(
	services?: Layer.Layer<Provided>,
) {
	return apiLayer.pipe(
		Layer.provide(Layer.merge(fakes, services ?? Layer.empty)),
		Layer.provide([noDatabase, HttpServer.layerServices]),
	);
}

/** `Authentication` asking `resolvePerson` who holds a request's credentials. */
export function identifiedBy(resolvePerson: PersonResolver): Layer.Layer<Authentication.Service> {
	return Layer.succeed(Authentication.Service, {
		handler: () => Effect.succeed(new Response(null, { status: 404 })),
		identify: identifyFromResolver(resolvePerson),
	});
}

/** The test server, with its web app at `webAppUrl`. */
export function serverSettingsWithWebAppAt(webAppUrl: string): Layer.Layer<ServerSettings.Service> {
	return Layer.succeed(
		ServerSettings.Service,
		ServerSettings.fromUrls({ isProduction: false, publicUrl: BASE_URL, webAppUrl }),
	);
}

/**
 * Services whose every method dies naming itself, nobody signed in, no
 * event stream open to listen on, and a bus in memory, so a case supplies exactly
 * what it is about.
 */
const fakes: Layer.Layer<TestServices> = Layer.mergeAll(
	unimplemented(Accounts.Service),
	// `/me` answers with these beside the signed-in person; a case about them supplies its own.
	unimplemented(Membership.Service, { workspaces: Effect.succeed([]) }),
	unimplemented(ProjectAdministration.Service),
	unimplemented(WorkspaceTimeZone.Service),
	unimplemented(Files.Service),
	unimplemented(FilePages.Service),
	unimplemented(BotAdministration.Service),
	unimplemented(WorkspaceSetup.Service),
	unimplemented(ModelProviderSetup.Service),
	unimplemented(SearchProviderSetup.Service),
	unimplemented(ComputerProviderSetup.Service),
	unimplemented(ComputerNetwork.Service),
	unimplemented(DesktopViewer.Service),
	unimplemented(ProjectComputerSetup.Service),
	unimplemented(GitHubApps.Service),
	unimplemented(GitHubConnectors.Service),
	unimplemented(ConnectorSetup.Service),
	unimplemented(Usage.Service),
	unimplemented(Notifications.Service),
	unimplemented(Chats.Service),
	unimplemented(ChatFiles.Service),
	unimplemented(ChatView.Service),
	unimplemented(Reactions.Service),
	unimplemented(ChatDetailsView.Service),
	unimplemented(Turns.Controls),
	unimplemented(Automations.Service),
	unimplemented(Automations.Webhooks),
	unimplemented(Automations.ConnectorEvents),
	Layer.succeed(StreamAccess.Service, closedStreamAccess),
	identifiedBy(async () => null),
	serverSettingsWithWebAppAt(WEB_ORIGIN),
	Layer.sync(EventBus.Service, () => EventBus.inProcess({ store: EventStore.inMemory() })),
);

/** Who a test says holds the credentials in `headers`, so HTTP tests run without a database. */
export type PersonResolver = (headers: Headers) => Promise<SignedInPerson | null>;

/** The `Authentication.identify` a test's resolver stands in for. */
function identifyFromResolver(resolvePerson: PersonResolver) {
	return (headers: Headers) =>
		Effect.map(
			Effect.promise(() => resolvePerson(headers)),
			(person) => (person ? { person, refreshedCookies: Cookies.empty } : undefined),
		);
}

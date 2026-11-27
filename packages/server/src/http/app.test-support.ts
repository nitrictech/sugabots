import type { CurrentUser } from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { PageAuthentication } from "@sugabots/core/authentication/page";
import type { SessionAuthentication } from "@sugabots/core/authentication/session";
import { sessionsFromCookies } from "@sugabots/core/authentication/testing";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import type { Database } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { noDatabase } from "@sugabots/core/database/testing";
import { Ids } from "@sugabots/core/ids/ids";
import { Operations } from "@sugabots/core/operations/registry";
import { Egress } from "@sugabots/core/providers/network/egress";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { Cookies, HttpRouter, HttpServer } from "effect/unstable/http";
import { Authentication } from "../auth/authentication.ts";
import { apiLayer } from "./app.ts";
import type { HttpServices } from "./services.ts";

/** The test API's address. */
export const BASE_URL = "http://localhost:3000";
/** Where the test app's web app is served, a browser origin it trusts besides its own. */
export const WEB_ORIGIN = "http://localhost:5173";

/** The cookie better-auth keeps a browser's session in. */
const SESSION_COOKIE = "better-auth.session_token";

/**
 * The headers a browser on the test app's web app sends once signed in with
 * session `token`: the session cookie, and the web app's origin, without which
 * a write with a cookie is refused.
 */
export function signedInWith(token: string): Record<string, string> {
	return { cookie: `${SESSION_COOKIE}=${token}`, origin: WEB_ORIGIN };
}

/** The session token in a request's cookie, as `signedInWith` put it there. */
export function sessionTokenIn(headers: Headers): string | undefined {
	const prefix = `${SESSION_COOKIE}=`;
	return headers
		.get("cookie")
		?.split(/;\s*/)
		.find((cookie) => cookie.startsWith(prefix))
		?.slice(prefix.length);
}

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
	| SessionAuthentication.Service
	| WebhookAuthentication.Service
	| PageAuthentication.Service
	| Ids.Service
	| ServerSettings.Service
	| EventBus.Service
	| Egress.Service;

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

/** `Authentication` asking `resolveMember` who holds a request's credentials. */
export function identifiedBy(resolveMember: MemberResolver): Layer.Layer<Authentication.Service> {
	return Layer.succeed(Authentication.Service, {
		handler: () => Effect.succeed(new Response(null, { status: 404 })),
		identify: identifyFromResolver(resolveMember),
		refreshedCookies: () => Effect.succeed(Cookies.empty),
		member: () => Effect.succeed(undefined),
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
 * what it is about. Sessions are authenticated by core's own authenticator,
 * from what `identifiedBy`'s resolver says the cookie holds, a long-running
 * operation's included, as there is no session row to read.
 */
const fakes: Layer.Layer<TestServices, never, Database> = Layer.mergeAll(
	// `/me` answers with the workspaces beside the current user; a case about them supplies its own.
	unimplemented(Operations.Service, { "workspaces.list": () => Effect.succeed([]) }),
	// A stream's case supplies the operation it follows.
	unimplemented(Operations.LongRunning),
	unimplemented(PageAuthentication.Service),
	identifiedBy(async () => null),
	sessionsFromCookies,
	// A webhook route's case supplies who its calls authenticate as.
	unimplemented(WebhookAuthentication.Service),
	Ids.layer,
	serverSettingsWithWebAppAt(WEB_ORIGIN),
	Egress.layer.pipe(Layer.provide(serverSettingsWithWebAppAt(WEB_ORIGIN)), Layer.orDie),
	Layer.sync(EventBus.Service, () => EventBus.inProcess()),
);

/** Whose session a test says the cookie in `headers` holds, so HTTP tests run without a database. */
export type MemberResolver = (headers: Headers) => Promise<CurrentUser | null>;

/** The `Authentication.identify` a test's resolver stands in for. */
function identifyFromResolver(resolveMember: MemberResolver) {
	return (headers: Headers) =>
		Effect.map(
			Effect.promise(() => resolveMember(headers)),
			(member) =>
				member
					? { member, session: `session-of-${member.id}`, refreshedCookies: Cookies.empty }
					: undefined,
		);
}

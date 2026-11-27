import {
	CONNECTOR_OAUTH_REDIRECT_PATH,
	CONNECTOR_SIGN_IN_CALLBACK_PATH,
} from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Effect } from "effect";
import {
	FindMyWay,
	HttpRouter,
	HttpServerRequest,
	type HttpServerResponse,
} from "effect/unstable/http";

/**
 * API paths that other systems were given before pods became projects, each
 * with the path that serves it now. Webhook senders, GitHub apps and OAuth
 * clients keep the addresses they were set up with.
 *
 * A trigger's id never changed, and an address under `/hooks/routines/` has
 * always held a trigger's id, so both old trigger paths reach the same one.
 */
const RENAMED_PATH_PREFIXES: ReadonlyArray<readonly [before: `/${string}`, now: string]> = [
	["/hooks/triggers/", "/webhooks/triggers/"],
	["/hooks/routines/", "/webhooks/triggers/"],
	["/hooks/connections/", "/webhooks/connectors/"],
	["/connections/github/made", "/connectors/github/made"],
	["/connections/github/installed", "/connectors/github/installed"],
	[CONNECTOR_OAUTH_REDIRECT_PATH, CONNECTOR_SIGN_IN_CALLBACK_PATH],
].map(([before, now]) => [`${API_BASE_PATH}${before}`, `${API_BASE_PATH}${now}`] as const);

/**
 * Serves a request to a path in {@link RENAMED_PATH_PREFIXES} as one to the
 * path that replaced it, with its query kept, before anything reads its path.
 * The old paths are matched as the router matches paths, with its settings:
 * by default ignoring a trailing slash, doubled slashes and case.
 */
export function serveRenamedPaths<E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest
> {
	// Built once for each router configuration requests are served with, not once a request.
	const routers = new WeakMap<Partial<FindMyWay.RouterConfig>, FindMyWay.Router<string>>();
	const routerFor = (config: Partial<FindMyWay.RouterConfig>) => {
		const built = routers.get(config) ?? renamedPaths(config);
		routers.set(config, built);
		return built;
	};
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const renamed = routerFor(yield* HttpRouter.RouterConfig).find(request.method, request.url);
		if (!renamed) return yield* effect;
		const rest = renamed.params["*"];
		const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
		const url = `${renamed.handler}${rest === undefined ? "" : encodeURI(rest)}${query}`;
		return yield* Effect.provideService(
			effect,
			HttpServerRequest.HttpServerRequest,
			request.modify({ url }),
		);
	});
}

/** A router over the old paths, configured as the app's, finding the path that replaced each. */
function renamedPaths(config: Partial<FindMyWay.RouterConfig>): FindMyWay.Router<string> {
	const router = FindMyWay.make<string>(config);
	for (const [before, now] of RENAMED_PATH_PREFIXES) {
		router.all(before.endsWith("/") ? `${before}*` : before, now);
	}
	return router;
}

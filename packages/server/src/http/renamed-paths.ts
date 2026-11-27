import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

/**
 * API paths that other systems were given before pods became projects, each
 * with the path that serves it now. Webhook senders and GitHub apps keep the
 * address they were set up with, so these are served for as long as an
 * installation upgraded from then may still be called at them.
 *
 * A trigger's id never changed, and an address under `/hooks/routines/` has
 * always held a trigger's id, so both old trigger paths reach the same one.
 */
const RENAMED_PATH_PREFIXES: ReadonlyArray<readonly [before: string, now: string]> = [
	["/hooks/triggers/", "/webhooks/triggers/"],
	["/hooks/routines/", "/webhooks/triggers/"],
	["/hooks/connections/", "/webhooks/connectors/"],
	["/connections/github/made", "/connectors/github/made"],
	["/connections/github/installed", "/connectors/github/installed"],
].map(([before, now]) => [`${API_BASE_PATH}${before}`, `${API_BASE_PATH}${now}`] as const);

/**
 * Serves a request to a path in {@link RENAMED_PATH_PREFIXES} as one to the
 * path that replaced it, with its query kept, before anything reads its path.
 */
export function serveRenamedPaths<E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest
> {
	return Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const renamed = RENAMED_PATH_PREFIXES.find(([before]) => startsWithPath(request.url, before));
		if (!renamed) return yield* effect;
		const [before, now] = renamed;
		const url = `${now}${request.url.slice(before.length)}`;
		return yield* Effect.provideService(
			effect,
			HttpServerRequest.HttpServerRequest,
			request.modify({ url }),
		);
	});
}

/** Whether `url` is `path`, or under it when `path` ends in `/`, ignoring the query. */
function startsWithPath(url: string, path: string): boolean {
	if (!url.startsWith(path)) return false;
	return path.endsWith("/") || url.length === path.length || url[path.length] === "?";
}

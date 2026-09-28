import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Layer } from "effect";
import { FindMyWay, HttpMiddleware, type HttpServerRequest } from "effect/unstable/http";
import { HttpApi } from "effect/unstable/httpapi";
import { ServerApi } from "./api.ts";

/**
 * Names each request's span by the route it matches, `GET /api/pods/:podId`,
 * rather than Effect's `http.server GET`. The span is named before routing, so
 * the route is looked up here, from the same API definition the router serves.
 */
export const requestSpanNames = Layer.succeed(HttpMiddleware.SpanNameGenerator, requestSpanName);

const AUTH_PATH = `${API_BASE_PATH}/auth/`;

const routes = FindMyWay.make<string>();
HttpApi.reflect(ServerApi, {
	onGroup: () => {},
	// HttpApi paths always start with "/".
	onEndpoint: ({ endpoint }) =>
		routes.on(endpoint.method, endpoint.path as FindMyWay.PathInput, endpoint.path),
});

function requestSpanName(request: HttpServerRequest.HttpServerRequest): string {
	const path = request.url.split("?", 1)[0] ?? request.url;
	// better-auth's paths are fixed, `/api/auth/sign-in/email`, so they name themselves.
	if (path.startsWith(AUTH_PATH)) return `${request.method} ${path}`;
	const route = routes.find(request.method, request.url)?.handler;
	if (route) return `${request.method} ${route}`;
	return path.startsWith(API_BASE_PATH) ? request.method : `${request.method} web app`;
}

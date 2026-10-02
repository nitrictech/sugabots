import { API_BASE_PATH, InternalServerError, NotFound } from "@sugabots/contracts/http";
import type { Database } from "@sugabots/core/database/database";
import type { EventBus } from "@sugabots/core/database/events/bus";
import { Installation } from "@sugabots/core/installation/installation";
import { Clock, Effect, Layer, type Types } from "effect";
import {
	HttpMethod,
	HttpMiddleware,
	HttpRouter,
	type HttpServer,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Authentication } from "../auth/authentication.ts";
import { requireCookieOrigin, sessionLayer } from "../auth/middleware.ts";
import { agentRoutes } from "../routes/agents/routes.ts";
import { chatRoutes } from "../routes/chats/routes.ts";
import { connectionRoutes } from "../routes/connections/routes.ts";
import { eventRoutes } from "../routes/events/routes.ts";
import { modelProviderRoutes } from "../routes/model-providers/routes.ts";
import { modelTrialRoutes } from "../routes/model-trials/routes.ts";
import { onboardingRoutes } from "../routes/onboarding/routes.ts";
import { podSandboxRoutes } from "../routes/pod-sandbox/routes.ts";
import { podRoutes } from "../routes/pods/routes.ts";
import { referralRoutes } from "../routes/referrals/routes.ts";
import { routineRoutes } from "../routes/routines/routes.ts";
import { sandboxProviderRoutes } from "../routes/sandbox-providers/routes.ts";
import { searchProviderRoutes } from "../routes/search-providers/routes.ts";
import { systemRoutes } from "../routes/system/routes.ts";
import { systemAgentRoutes } from "../routes/system-agents/routes.ts";
import { threadRoutes } from "../routes/threads/routes.ts";
import { toolApprovalRoutes } from "../routes/tool-approvals/routes.ts";
import { usageRoutes } from "../routes/usage/routes.ts";
import { workspaceRoutes } from "../routes/workspaces/routes.ts";
import { ServerApi } from "./api.ts";
import { desktopViewerRoutes } from "./desktop-viewer.ts";
import { failureResponse } from "./errors.ts";
import type { HttpServices } from "./services.ts";
import { limitJsonBody, validateRequestLayer } from "./validation.ts";

/** Sign-up, sign-in, workspaces and invitations, answered by better-auth. */
const betterAuthRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		yield* router.add("*", `${API_BASE_PATH}/auth/*`, (request) =>
			toWebRequest(request).pipe(
				Effect.flatMap(authentication.handler),
				Effect.map(HttpServerResponse.fromWeb),
			),
		);
	}),
);

/**
 * The API, as routes on an `HttpRouter`.
 *
 * What the endpoints are is `Api` in `@sugabots/contracts/http`, which
 * `packages/sdk` derives its client from; this is where each group gets its
 * handlers and each middleware its implementation. A group left out, or a
 * handler missing from one, does not compile. better-auth's wildcard is beside
 * the API rather than in it, because the client reaches it through
 * better-auth's own SDK.
 *
 * The routes take their services from the layer's context: the use cases and
 * views in `HttpServices`, and the database, installation, sessions and event
 * bus in `ApiInfrastructure`. Each use case authorizes the person the
 * request's session belongs to, so no middleware decides access.
 * `createTestApp` in `app.test-support.ts` drives the same routes with fakes.
 */
export const apiLayer: Layer.Layer<never, never, HttpServices | ApiInfrastructure> = Layer.mergeAll(
	HttpApiBuilder.layer(ServerApi).pipe(
		Layer.provide(
			Layer.mergeAll(
				systemRoutes,
				workspaceRoutes,
				eventRoutes,
				onboardingRoutes,
				podRoutes,
				systemAgentRoutes,
				modelTrialRoutes,
				modelProviderRoutes,
				searchProviderRoutes,
				sandboxProviderRoutes,
				podSandboxRoutes,
				connectionRoutes,
				agentRoutes,
				chatRoutes,
				routineRoutes,
				toolApprovalRoutes,
				threadRoutes,
				usageRoutes,
				referralRoutes,
			).pipe(Layer.provide(Layer.merge(sessionLayer, validateRequestLayer))),
		),
	),
	betterAuthRoutes,
	desktopViewerRoutes,
).pipe(
	// Each handler's Effect runs against the process's database, which the
	// router hands to it per request rather than capturing it once.
	HttpRouter.provideRequest(Layer.effectContext(Effect.context<Database>())),
	Layer.provide(
		HttpRouter.middleware(
			Effect.map(Installation.Service, ({ trustedOrigins }) => everyRequest(trustedOrigins)),
			{ global: true },
		),
	),
);

/**
 * What the API is built on besides the core services: the database each
 * request runs against, the installation's addresses, who holds a session,
 * the bus the streams listen on, and the platform the router serves from.
 */
type ApiInfrastructure =
	| Database
	| Installation.Service
	| Authentication.Service
	| EventBus.Service
	| HttpRouter.HttpRouter
	| Layer.Success<typeof HttpServer.layerServices>;

/**
 * The request as a web `Request`, for better-auth.
 *
 * Built from the body `limitJsonBody` already read and cached, because the
 * original stream has been consumed by then.
 */
function toWebRequest(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Request> {
	return Effect.gen(function* () {
		const url = HttpServerRequest.toURL(request);
		if (url._tag === "None") {
			return yield* Effect.die(new Error(`Unparseable request URL ${request.url}`));
		}
		const body = HttpMethod.hasBody(request.method) ? yield* request.text : undefined;
		return new Request(url.value, { method: request.method, headers: request.headers, body });
	}).pipe(Effect.orDie);
}

/** What happens to every request, the outermost first. */
function everyRequest(origins: readonly string[]) {
	const cors = HttpMiddleware.cors({
		allowedOrigins: origins,
		allowedHeaders: ["authorization", "content-type", "idempotency-key", "last-event-id"],
		credentials: true,
	});
	const cookieOrigin = requireCookieOrigin(origins);
	// Browser requests carry an HttpOnly session cookie. Bearer clients may also
	// send Authorization, but the token issuance header is not exposed to pages.
	return (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
		cors(
			serverTiming(defectsAsInternal(unknownRouteAsNotFound(cookieOrigin(limitJsonBody(effect))))),
		);
}

/**
 * A defect is logged and answers `InternalServerError`. Its message may name a
 * table, a query or a file path, so it goes to the log and not to the caller.
 */
function defectsAsInternal<E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> {
	return Effect.catchDefect(effect, (defect) =>
		Effect.logError("Request failed", defect).pipe(
			Effect.as(
				failureResponse(
					InternalServerError,
					new InternalServerError({ message: "Internal server error" }),
					500,
				),
			),
		),
	);
}

/** A path no route matches answers `NotFound` in the API's error shape, like any other. */
function unknownRouteAsNotFound<E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	R | HttpServerRequest.HttpServerRequest
> {
	return Effect.catchIf(
		effect,
		(error) => HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound",
		() =>
			Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
				failureResponse(
					NotFound,
					new NotFound({ message: `No route for ${request.method} ${request.url}` }),
					404,
				),
			),
	);
}

/**
 * How long the request took and which trace it is, in the `Server-Timing`
 * header: visible in the browser's network panel with no trace backend at
 * all, and the trace id finds the full trace when there is one.
 */
function serverTiming<E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> {
	return Effect.gen(function* () {
		const started = yield* Clock.currentTimeMillis;
		const response = yield* effect;
		const duration = (yield* Clock.currentTimeMillis) - started;
		const span = yield* Effect.option(Effect.currentParentSpan);
		const trace = span._tag === "Some" ? `, trace;desc="${span.value.traceId}"` : "";
		return HttpServerResponse.setHeader(response, "server-timing", `app;dur=${duration}${trace}`);
	});
}

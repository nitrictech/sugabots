import { API_BASE_PATH, InternalServerError, NotFound } from "@sugabots/contracts/http";
import type { PageAuthentication } from "@sugabots/core/authentication/page";
import type { SessionAuthentication } from "@sugabots/core/authentication/session";
import type { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import type { Database } from "@sugabots/core/database/database";
import type { EventBus } from "@sugabots/core/database/events/bus";
import { Ids } from "@sugabots/core/ids/ids";
import type { Egress } from "@sugabots/core/providers/network/egress";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { processLayer } from "@sugabots/core/tiers";
import { UserText, userText } from "@sugabots/errors";
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
import { approvalRoutes } from "../routes/approvals/routes.ts";
import { automationRoutes } from "../routes/automations/routes.ts";
import { botRoutes } from "../routes/bots/routes.ts";
import { chatRoutes } from "../routes/chats/routes.ts";
import { computerProviderRoutes } from "../routes/computer-providers/routes.ts";
import { connectorRoutes } from "../routes/connectors/routes.ts";
import { eventRoutes } from "../routes/events/routes.ts";
import { fileRoutes } from "../routes/files/routes.ts";
import { gitHubConnectorRoutes, gitHubWebhookRoutes } from "../routes/github/routes.ts";
import { modelProviderRoutes } from "../routes/model-providers/routes.ts";
import { notificationRoutes } from "../routes/notifications/routes.ts";
import { projectComputerRoutes } from "../routes/project-computer/routes.ts";
import { projectRoutes } from "../routes/projects/routes.ts";
import { referralRoutes } from "../routes/referrals/routes.ts";
import { searchProviderRoutes } from "../routes/search-providers/routes.ts";
import { systemRoutes } from "../routes/system/routes.ts";
import { systemBotRoutes } from "../routes/system-bots/routes.ts";
import { usageRoutes } from "../routes/usage/routes.ts";
import { workspaceSetupRoutes } from "../routes/workspace-setup/routes.ts";
import { workspaceRoutes } from "../routes/workspaces/routes.ts";
import { ServerApi } from "./api.ts";
import { contentPageRoutes, onlyPagesOnContentHost } from "./content-pages.ts";
import { desktopViewerRoutes } from "./desktop-viewer.ts";
import { failureResponse } from "./errors.ts";
import type { HttpServices } from "./services.ts";
import { limitJsonBody, validateRequestLayer } from "./validation.ts";

/** Sign-up, sign-in, workspaces and invitations, answered by better-auth. */
const betterAuthRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const authentication = yield* Authentication.Service;
		// The request as `limitJsonBody` read it, not as the route was given it.
		yield* router.add("*", `${API_BASE_PATH}/auth/*`, () =>
			limitJsonBody(
				HttpServerRequest.HttpServerRequest.pipe(
					Effect.flatMap(toWebRequest),
					Effect.flatMap(authentication.handler),
					Effect.map(HttpServerResponse.fromWeb),
				),
			),
		);
	}),
).pipe(processLayer);

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
 * The routes take their services from the layer's context: the operations and
 * views in `HttpServices`, and the database, server settings, sessions and event
 * bus in `ApiInfrastructure`. The `Session` middleware authenticates the
 * request; each operation authorizes the principal it built, so no middleware
 * decides access.
 * `createTestApp` in `app.test-support.ts` drives the same routes with fakes.
 */
export const apiLayer: Layer.Layer<never, never, HttpServices | ApiInfrastructure> = Layer.mergeAll(
	HttpApiBuilder.layer(ServerApi).pipe(
		Layer.provide(
			Layer.mergeAll(
				systemRoutes,
				workspaceRoutes,
				eventRoutes,
				workspaceSetupRoutes,
				projectRoutes,
				systemBotRoutes,
				modelProviderRoutes,
				searchProviderRoutes,
				computerProviderRoutes,
				projectComputerRoutes,
				gitHubConnectorRoutes,
				gitHubWebhookRoutes,
				connectorRoutes,
				fileRoutes,
				botRoutes,
				chatRoutes,
				automationRoutes,
				approvalRoutes,
				usageRoutes,
				referralRoutes,
				notificationRoutes,
			).pipe(Layer.provide(Layer.merge(sessionLayer, validateRequestLayer))),
		),
	),
	betterAuthRoutes,
	desktopViewerRoutes,
	contentPageRoutes,
).pipe(
	// Each handler's Effect runs against the process's database, which the
	// router hands to it per request rather than capturing it once.
	HttpRouter.provideRequest(processLayer(Layer.effectContext(Effect.context<Database>()))),
	Layer.provide(
		HttpRouter.middleware(
			Effect.gen(function* () {
				const { trustedOrigins, contentOrigin } = yield* ServerSettings.Service;
				return everyRequest(trustedOrigins, contentOrigin, yield* Ids.Service);
			}),
			{ global: true },
		),
	),
);

/**
 * What the API is built on besides the core services: the database each
 * request runs against, the server's addresses, who holds a session and the
 * authenticator that makes its principal, the authenticator that admits a
 * webhook call by the secret of the trigger or GitHub app it is addressed to,
 * the ids each request's call takes, the bus the streams listen on, and the
 * platform the router serves from.
 */
type ApiInfrastructure =
	| Egress.Service
	| Database
	| ServerSettings.Service
	| Authentication.Service
	| SessionAuthentication.Service
	| WebhookAuthentication.Service
	| PageAuthentication.Service
	| Ids.Service
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
function everyRequest(
	origins: readonly string[],
	contentOrigin: string | undefined,
	ids: Ids.Interface,
) {
	const cors = HttpMiddleware.cors({
		allowedOrigins: origins,
		allowedHeaders: ["content-type", "idempotency-key", "last-event-id"],
		credentials: true,
	});
	const cookieOrigin = requireCookieOrigin(origins);
	const contentHostOnlyPages = onlyPagesOnContentHost(contentOrigin);
	return (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
		contentHostOnlyPages(
			cors(serverTiming(defectsAsInternal(ids, unknownRouteAsNotFound(cookieOrigin(effect))))),
		);
}

/**
 * A defect is logged and answers `InternalServerError`. Its message may name a
 * table, a query or a file path, so it goes to the log and not to the caller,
 * who gets a reference id that finds the log entry.
 */
function defectsAsInternal<E, R>(
	ids: Ids.Interface,
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> {
	return Effect.catchDefect(effect, (defect) =>
		Effect.gen(function* () {
			const reference = yield* ids.random;
			yield* Effect.logError("Request failed", defect).pipe(Effect.annotateLogs({ reference }));
			return failureResponse(
				InternalServerError,
				new InternalServerError({
					// The reference is an id minted here, never text from the defect.
					message: userText`Something unexpected went wrong. Reference: ${UserText.unchecked(reference)}`,
					reference,
				}),
			);
		}),
	);
}

/** A path no route matches answers `NotFound` in the API's error shape, like any other. */
function unknownRouteAsNotFound<E, R>(
	effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> {
	return Effect.catchIf(
		effect,
		(error) => HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound",
		() =>
			Effect.succeed(
				failureResponse(
					NotFound,
					new NotFound({ message: userText`There is nothing at this address.` }),
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

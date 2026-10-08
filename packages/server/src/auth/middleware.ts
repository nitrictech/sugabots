import {
	API_BASE_PATH,
	CurrentUser,
	Forbidden,
	Session,
	Unauthorized,
} from "@sugabots/contracts/http";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { userText } from "@sugabots/errors";
import { Effect, Layer } from "effect";
import { Cookies, HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { failureResponse } from "../http/errors.ts";
import { Authentication } from "./authentication.ts";

/**
 * Bearer authentication for native and script clients, or a Better Auth cookie
 * session for browsers. An explicit Authorization header never falls back to a
 * cookie if malformed or expired.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects a cookie-authenticated write whose Origin is not in `trustedOrigins`,
 * which is what stops CSRF. Routes under `/auth` and `/hooks` are exempt:
 * better-auth checks for itself, and webhooks carry no browser cookie.
 */
export function requireCookieOrigin(trustedOrigins: readonly string[]) {
	const trusted = new Set(trustedOrigins);
	const exempt = [`${API_BASE_PATH}/auth/`, `${API_BASE_PATH}/hooks/`];
	return <E, R>(
		effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
	): Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | HttpServerRequest.HttpServerRequest
	> =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const { headers } = request;
			if (
				SAFE_METHODS.has(request.method) ||
				exempt.some((prefix) => request.url.startsWith(prefix)) ||
				!headers.cookie ||
				bearerToken(headers.authorization)
			) {
				return yield* effect;
			}
			if (!headers.origin || !trusted.has(headers.origin)) {
				return failureResponse(
					Forbidden,
					new Forbidden({ message: userText`Untrusted request origin` }),
					403,
				);
			}
			return yield* effect;
		});
}

/** The `Session` middleware, asking `Authentication` who holds the request's credentials. */
export const sessionLayer = Layer.effect(
	Session,
	Effect.map(
		Authentication.Service,
		({ identify }) =>
			(httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const authorization = request.headers.authorization;
					let headers = new Headers(request.headers);
					if (authorization !== undefined) {
						const token = bearerToken(authorization);
						if (!token) {
							return yield* new Unauthorized({ message: userText`Invalid Authorization header` });
						}
						headers = new Headers({ authorization: `Bearer ${token}` });
					}

					const holder = yield* identify(headers);
					if (!holder) {
						return yield* new Unauthorized({ message: userText`Invalid or expired session` });
					}
					if (!Cookies.isEmpty(holder.refreshedCookies)) {
						yield* HttpEffect.appendPreResponseHandler((_request, response) =>
							Effect.succeed(HttpServerResponse.mergeCookies(response, holder.refreshedCookies)),
						);
					}
					return yield* Effect.provideService(httpEffect, CurrentUser, holder.user);
				}),
	),
);

/**
 * Runs a handler's work as the person the request's session belongs to, the
 * actor core authorizes, for an endpoint behind `Session`.
 */
export const asSessionUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.flatMap(CurrentUser, (user) =>
		// `Session` put the user there only once `identify` accepted the credentials.
		effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(user.id))),
	);

export function bearerToken(header: string | undefined): string | undefined {
	const [scheme, ...rest] = header?.trim().split(/\s+/) ?? [];
	if (scheme?.toLowerCase() !== "bearer") {
		return undefined;
	}
	return rest.join(" ") || undefined;
}

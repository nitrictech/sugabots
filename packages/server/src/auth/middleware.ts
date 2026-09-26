import { CurrentUser, Forbidden, Session, Unauthorized } from "@sugabots/contracts/http";
import { Effect, Layer } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";
import { API_BASE_PATH } from "../config.ts";
import { failureResponse } from "../http/errors.ts";
import type { SessionResolver } from "./session.ts";

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
					new Forbidden({ message: "Untrusted request origin" }),
					403,
				);
			}
			return yield* effect;
		});
}

/** The `Session` middleware, resolving the request's credentials with `resolve`. */
export function sessionLayer(resolve: SessionResolver) {
	return Layer.succeed(Session, (httpEffect) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const authorization = request.headers.authorization;
			let headers = new Headers(request.headers);
			if (authorization !== undefined) {
				const token = bearerToken(authorization);
				if (!token) {
					return yield* new Unauthorized({ message: "Invalid Authorization header" });
				}
				headers = new Headers({ authorization: `Bearer ${token}` });
			}

			const session = yield* Effect.promise(() => resolve(headers));
			if (!session) {
				return yield* new Unauthorized({ message: "Invalid or expired session" });
			}
			return yield* Effect.provideService(httpEffect, CurrentUser, session.user);
		}),
	);
}

export function bearerToken(header: string | undefined): string | undefined {
	const [scheme, ...rest] = header?.trim().split(/\s+/) ?? [];
	if (scheme?.toLowerCase() !== "bearer") {
		return undefined;
	}
	return rest.join(" ") || undefined;
}

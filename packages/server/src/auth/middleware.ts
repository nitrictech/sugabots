import {
	API_BASE_PATH,
	CurrentUserOfRequest,
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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects a cookie-authenticated write whose Origin is not in `trustedOrigins`,
 * which is what stops CSRF. Routes under `/auth` and `/webhooks` are exempt:
 * better-auth checks for itself, and webhooks carry no browser cookie.
 */
export function requireCookieOrigin(trustedOrigins: readonly string[]) {
	const trusted = new Set(trustedOrigins);
	const exempt = [`${API_BASE_PATH}/auth/`, `${API_BASE_PATH}/webhooks/`];
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
				!headers.cookie
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

/** The `Session` middleware, asking `Authentication` whose session cookie the request carries. */
export const sessionLayer = Layer.effect(
	Session,
	Effect.map(
		Authentication.Service,
		({ identify }) =>
			(httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const holder = yield* identify(new Headers(request.headers));
					if (!holder) {
						return yield* new Unauthorized({ message: userText`Invalid or expired session` });
					}
					if (!Cookies.isEmpty(holder.refreshedCookies)) {
						yield* HttpEffect.appendPreResponseHandler((_request, response) =>
							Effect.succeed(HttpServerResponse.mergeCookies(response, holder.refreshedCookies)),
						);
					}
					return yield* Effect.provideService(httpEffect, CurrentUserOfRequest, holder.member);
				}),
	),
);

/**
 * Runs a handler's work as the member the request's session belongs to, the
 * principal core authorizes, for an endpoint behind `Session`.
 */
export const asCurrentUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.flatMap(CurrentUserOfRequest, (member) =>
		// `Session` put the member there only once `identify` accepted the credentials.
		effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedMemberId.vouchedFor(member.id))),
	);

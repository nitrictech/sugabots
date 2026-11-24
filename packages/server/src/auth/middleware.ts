import {
	API_BASE_PATH,
	CurrentUserOfRequest,
	Forbidden,
	Session,
	Unauthorized,
} from "@sugabots/contracts/http";
import type {
	FailureOf,
	HttpOperationName,
	InputOf,
	Manifest,
	OutputOf,
} from "@sugabots/contracts/operations";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Ids } from "@sugabots/core/ids/ids";
import type { Call } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import type { MemberSession } from "@sugabots/core/principal";
import { userText } from "@sugabots/errors";
import { Context, Effect, Layer } from "effect";
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

/**
 * The `Session` middleware: authenticates the request once, through core's
 * session authenticator, from better-auth's reading of its cookie or from a
 * bearer token, and gives the endpoint what it found: the member as the API
 * names them, and the principal and call `operationCaller` hands an operation.
 */
export const sessionLayer = Layer.effect(
	Session,
	Effect.gen(function* () {
		const authentication = yield* Authentication.Service;
		const sessions = yield* SessionAuthentication.Service;
		const ids = yield* Ids.Service;
		return (httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const headers = new Headers(request.headers);
				// better-auth reads the cookie once; the authenticator and the
				// member's name both come from that one reading.
				const identified = yield* authentication.identify(headers);
				const withCookie = Effect.provideService(SessionAuthentication.Cookies, {
					read: () =>
						Effect.succeed(
							identified && { session: identified.session, member: identified.member.id },
						),
				});
				const principal = yield* withCookie(sessions.authenticate(headers)).pipe(
					Effect.catchTag("SessionInvalid", () => Effect.fail(signedOut())),
				);
				const member = identified?.member ?? (yield* authentication.member(principal.member));
				if (!member) return yield* signedOut();
				if (identified && !Cookies.isEmpty(identified.refreshedCookies)) {
					const { refreshedCookies } = identified;
					yield* HttpEffect.appendPreResponseHandler((_request, response) =>
						Effect.succeed(HttpServerResponse.mergeCookies(response, refreshedCookies)),
					);
				}
				const call: Call = { kind: "request", request: yield* ids.next };
				return yield* httpEffect.pipe(
					Effect.provideService(CurrentUserOfRequest, member),
					Effect.provideService(AuthenticatedRequest, { principal, call }),
				);
			});
	}),
);

/** The refusal of a request with no session, or one that has expired or was revoked. */
const signedOut = () => new Unauthorized({ message: userText`Invalid or expired session` });

/**
 * What `sessionLayer` authenticated for the request being answered: an
 * ordinary request, which may trust better-auth's cookie cache. A
 * long-running operation, such as following a stream, is to authenticate with
 * `authenticateLongRunning` instead, which reads the session's row.
 */
interface AuthenticatedRequest {
	/** The member signed in, as better-auth's cookie cache or the bearer token's row has them. */
	readonly principal: MemberSession;
	/** This request, as the call each operation is handed. */
	readonly call: Call;
}

/**
 * The request `sessionLayer` authenticated, for the endpoint answering it.
 * Undefined outside an endpoint behind `Session`.
 */
const AuthenticatedRequest = Context.Reference<AuthenticatedRequest | undefined>(
	"@sugabots/server/AuthenticatedRequest",
	{ defaultValue: () => undefined },
);

/** The request `sessionLayer` authenticated; a defect for an endpoint not behind `Session`. */
const authenticatedRequest = Effect.gen(function* () {
	const authenticated = yield* AuthenticatedRequest;
	if (authenticated) return authenticated;
	return yield* Effect.die(
		new Error("Only an endpoint behind the Session middleware has a principal"),
	);
});

/**
 * The function that calls an operation for the member whose session the
 * request carries, as the request's call: `call(name, input)`, the whole of a
 * handler for an endpoint behind `Session` that the exposure manifest offers
 * an operation at, besides shaping its input and mapping its errors with
 * `asHttpError`. Yield it where a group's handlers are built.
 */
export const operationCaller = Effect.map(
	Operations.Service,
	(operations) =>
		<Name extends HttpOperationName<Manifest>>(
			name: Name,
			input: InputOf<Name>,
		): Effect.Effect<OutputOf<Name>, FailureOf<Name>> =>
			Effect.flatMap(authenticatedRequest, ({ principal, call }) =>
				operations[name](principal, input, call),
			),
);

/**
 * Runs a handler's work as the member the request's session belongs to, for
 * an endpoint behind `Session` whose service still reads `CurrentActor`
 * rather than being called through an operation (see `operationCaller`).
 */
export const asCurrentUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.flatMap(CurrentUserOfRequest, (member) =>
		// `Session` put the member there only once the session authenticator accepted the credentials.
		effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedMemberId.vouchedFor(member.id))),
	);

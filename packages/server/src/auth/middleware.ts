import {
	API_BASE_PATH,
	AuthenticatedRequest,
	CurrentUserOfRequest,
	Forbidden,
	Session,
	Unauthorized,
} from "@sugabots/contracts/http";
import type {
	FailureOf,
	HttpOperationName,
	InputOf,
	LongRunningOperationName,
	OperationContracts,
	OutputOf,
	OwnEndpointOperationName,
} from "@sugabots/contracts/operations";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import type { Call, Running } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import type { MemberSession } from "@sugabots/core/principal";
import { processLayer } from "@sugabots/core/tiers";
import { userText } from "@sugabots/errors";
import { Effect, Layer, type Scope } from "effect";
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
		return (httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const headers = new Headers(request.headers);
				// better-auth reads the cookie once; the authenticator and the
				// member's name both come from that one reading.
				const identified = yield* authentication.identify(headers);
				const cookie: SessionAuthentication.CookieSession | undefined = identified && {
					session: identified.session,
					member: identified.member.id,
				};
				const withCookie = Effect.provideService(SessionAuthentication.Cookies, {
					read: () => Effect.succeed(cookie),
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
				const call: Call = { kind: "request" };
				return yield* httpEffect.pipe(
					Effect.provideService(CurrentUserOfRequest, member),
					Effect.provideService(AuthenticatedRequest, { principal, call }),
				);
			});
	}),
).pipe(processLayer);

/** The refusal of a request with no session, or one that has expired or was revoked. */
const signedOut = () => new Unauthorized({ message: userText`Invalid or expired session` });

declare module "@sugabots/contracts/http/middleware" {
	/** The session and call established when the request was admitted. */
	interface RequestAuthentication {
		readonly principal: MemberSession;
		readonly call: Call;
	}
}

/** The operations the HTTP API serves: at endpoints derived from their contracts, or their own. */
type ServedOperationName =
	| HttpOperationName<OperationContracts>
	| OwnEndpointOperationName<OperationContracts>;

/**
 * The function that calls an operation for the member whose session the
 * request carries, as the request's call: `call(name, input)`. The handler
 * of every endpoint derived from a contract is this and `answerAsHttp`; an
 * endpoint of an operation's own shapes its input and answer around it.
 * Yield it where a group's handlers are built.
 */
export const operationCaller = Effect.map(
	Operations.Service,
	(operations) =>
		<Name extends ServedOperationName>(
			name: Name,
			input: InputOf<Name>,
		): Effect.Effect<OutputOf<Name>, FailureOf<Name>, AuthenticatedRequest> =>
			Effect.flatMap(Effect.service(AuthenticatedRequest), ({ principal, call }) =>
				operations[name](principal, input, call),
			),
);

/** Starts a long-running operation for the session admitted by the middleware. */
export const longRunningCaller = Effect.map(
	Operations.LongRunning,
	(operations) =>
		<Name extends LongRunningOperationName>(
			name: Name,
			input: InputOf<Name>,
		): Effect.Effect<
			Running<OutputOf<Name>>,
			FailureOf<Name>,
			Scope.Scope | AuthenticatedRequest
		> =>
			Effect.flatMap(Effect.service(AuthenticatedRequest), ({ principal, call }) =>
				operations[name](principal, input, call),
			),
);

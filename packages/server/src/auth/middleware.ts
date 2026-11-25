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
	LongRunningOperationName,
	Manifest,
	OutputOf,
} from "@sugabots/contracts/operations";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import { Ids } from "@sugabots/core/ids/ids";
import type { Call, Running } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import type { MemberSession } from "@sugabots/core/principal";
import { processLayer, Tier } from "@sugabots/core/tiers";
import { userText } from "@sugabots/errors";
import { Context, Effect, Layer, Option, type Scope } from "effect";
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
		const ids = yield* Ids.Service;
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
				const call: Call = { kind: "request", request: yield* ids.next };
				return yield* httpEffect.pipe(
					Effect.provideService(CurrentUserOfRequest, member),
					Effect.provideService(AuthenticatedRequest, { principal, call, headers, cookie }),
				);
			});
	}),
).pipe(processLayer);

/** The refusal of a request with no session, or one that has expired or was revoked. */
const signedOut = () => new Unauthorized({ message: userText`Invalid or expired session` });

/**
 * What `sessionLayer` authenticated for the request being answered: an
 * ordinary request, which may trust better-auth's cookie cache. A
 * long-running operation, such as following a stream, is to authenticate with
 * `authenticateLongRunning` instead, which reads the session's row.
 */
interface RequestAuthentication {
	/** The member signed in, as better-auth's cookie cache or the bearer token's row has them. */
	readonly principal: MemberSession;
	/** This request, as the call each operation is handed. */
	readonly call: Call;
	/** The request's headers, which a long-running operation authenticates from again. */
	readonly headers: Headers;
	/** better-auth's one reading of the request's cookie, which that reuses. */
	readonly cookie: SessionAuthentication.CookieSession | undefined;
}

/**
 * The request `sessionLayer` authenticated, for the endpoint answering it. A
 * request-tier service, so no layer built once can require or provide it.
 */
class AuthenticatedRequest extends Context.Service<AuthenticatedRequest, RequestAuthentication>()(
	"@sugabots/server/AuthenticatedRequest",
) {
	declare readonly [Tier]: "request";
}

/**
 * The request `sessionLayer` authenticated; a defect for an endpoint not behind `Session`.
 *
 * Read as an option rather than required: `Session` declares what it provides in
 * `contracts`, which cannot name these types, so an endpoint's type cannot ask for
 * this service.
 */
const authenticatedRequest = Effect.gen(function* () {
	const authenticated = yield* Effect.serviceOption(AuthenticatedRequest);
	if (Option.isSome(authenticated)) return authenticated.value;
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
 * The function that starts a long-running operation, such as following a
 * stream, for the member whose session the request carries:
 * `follow(name, input)`. It authenticates the request again from the
 * session's row, not better-auth's cookie cache, so a session revoked since
 * the cache was filled can't open one; that is refused as `Unauthorized`.
 * What the operation holds open belongs to the scope it is run in. Yield it
 * where a group's handlers are built.
 */
export const longRunningCaller = Effect.gen(function* () {
	const operations = yield* Operations.LongRunning;
	const sessions = yield* SessionAuthentication.Service;
	return <Name extends LongRunningOperationName>(
		name: Name,
		input: InputOf<Name>,
	): Effect.Effect<Running<OutputOf<Name>>, FailureOf<Name> | Unauthorized, Scope.Scope> =>
		Effect.gen(function* () {
			const principal = yield* principalFromSessionRow(sessions);
			const { call } = yield* authenticatedRequest;
			return yield* operations[name](principal, input, call);
		});
});

/**
 * An effect that refuses the request as `Unauthorized` unless its session's
 * row still holds, whatever better-auth's cookie cache says, for an endpoint
 * that answers who is signed in. Yield it where a group's handlers are built.
 */
export const sessionRowCheck = Effect.map(SessionAuthentication.Service, (sessions) =>
	Effect.asVoid(principalFromSessionRow(sessions)),
);

/** The member whose session the request carries, read again from the session's row. */
function principalFromSessionRow(sessions: SessionAuthentication.Interface) {
	return Effect.gen(function* () {
		const { headers, cookie } = yield* authenticatedRequest;
		return yield* sessions.authenticateLongRunning(headers).pipe(
			Effect.provideService(SessionAuthentication.Cookies, {
				read: () => Effect.succeed(cookie),
			}),
			Effect.catchTag("SessionInvalid", () => Effect.fail(signedOut())),
		);
	});
}

export * as SessionAuthentication from "./session.ts";

import { memberStream, streamEvent } from "@sugabots/contracts";
import { type DomainError, userText } from "@sugabots/errors";
import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import { Context, Effect, ErrorReporter, Layer, Schema } from "effect";
import { query, serviceOperations, transaction } from "../database/database.ts";
import { EventOutbox } from "../database/events/outbox.ts";
import { session } from "../database/schema.ts";
import { authenticated, type MemberSession } from "../principal.ts";
import { processLayer, Tier } from "../tiers.ts";

/**
 * The authenticator for a member's session: the HTTP API's, the event
 * stream's and the desktop viewer's way in. A request carries better-auth's
 * session cookie, or the session's token as a bearer.
 *
 * Ordinary cookie requests use the entrypoint's session lookup. A long-running
 * operation reads the session's row again before it opens. A bearer token is
 * always authenticated from its session's row.
 *
 * Each call takes better-auth's reading of the request's cookie as
 * {@link Cookies}, which the entrypoint provides for that request.
 */
export interface Interface {
	/** The session `headers` carry, for an ordinary request. */
	readonly authenticate: (
		headers: Headers,
	) => Effect.Effect<MemberSession, SessionInvalid, Cookies>;
	/** The session `headers` carry, read from its row, for a long-running operation. */
	readonly authenticateLongRunning: (
		headers: Headers,
	) => Effect.Effect<MemberSession, SessionInvalid, Cookies>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SessionAuthentication",
) {
	declare readonly [Tier]: "process";
}

/**
 * better-auth's reading of one request's session cookie, which it signs and
 * caches. The entrypoint provides it from better-auth, which owns sessions,
 * for each request it authenticates, so better-auth reads a request's cookie
 * once however much else the entrypoint takes from that reading; core only
 * builds the principal from what it found.
 *
 * @effect-leakable-service
 */
export interface CookiesInterface {
	/** The session whose cookie `headers` carry, or `undefined` when they carry no good one. */
	readonly read: (headers: Headers) => Effect.Effect<CookieSession | undefined>;
}

export class Cookies extends Context.Service<Cookies, CookiesInterface>()(
	"@sugabots/core/SessionAuthentication/Cookies",
) {
	declare readonly [Tier]: "request";
}

/** A session as better-auth's cookie, or its cookie cache, names it. */
export interface CookieSession {
	readonly session: string;
	readonly member: string;
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SessionAuthentication");

	/** The unexpired session row `where` picks, as its member's principal. */
	const sessionWhere = (where: SQL | undefined) =>
		query((db) =>
			db
				.select({ session: session.id, member: session.memberId })
				.from(session)
				.where(and(where, gt(session.expiresAt, sql`now()`)))
				.limit(1),
		).pipe(
			Effect.flatMap(([row]) =>
				row ? Effect.succeed(authenticated.memberSession(row)) : Effect.fail(new SessionInvalid()),
			),
		);

	const fromBearer = (token: string) => sessionWhere(eq(session.token, token));

	const fromCookie = (headers: Headers) =>
		Effect.gen(function* () {
			const cookies = yield* Cookies;
			const found = yield* cookies.read(headers);
			if (!found) return yield* Effect.fail(new SessionInvalid());
			return found;
		});

	return Service.of({
		authenticate: (headers) =>
			operation(
				"authenticate",
				Effect.gen(function* () {
					const token = bearerTokenIn(headers);
					if (token !== undefined) return yield* fromBearer(token);
					return authenticated.memberSession(yield* fromCookie(headers));
				}),
			),

		authenticateLongRunning: (headers) =>
			operation(
				"authenticateLongRunning",
				Effect.gen(function* () {
					const token = bearerTokenIn(headers);
					if (token !== undefined) return yield* fromBearer(token);
					const cached = yield* fromCookie(headers);
					return yield* sessionWhere(
						and(eq(session.id, cached.session), eq(session.memberId, cached.member)),
					);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/**
 * When `principal`'s session expires, read again from its row, for a
 * long-running operation proving again; `undefined` once it has ended or
 * expired, which ends the operation.
 */
export const expiryOf = (principal: MemberSession) =>
	query((db) =>
		db
			.select({ expiresAt: session.expiresAt })
			.from(session)
			.where(
				and(
					eq(session.id, principal.session),
					eq(session.memberId, principal.member),
					gt(session.expiresAt, sql`now()`),
				),
			)
			.limit(1),
	).pipe(Effect.map(([row]) => row?.expiresAt));

/**
 * Records that the session `ended.session` of `ended.member` ended, as
 * better-auth signs a member out or revokes a session, on the member's own
 * stream, where every stream and desktop viewer opened with that session
 * hears it and ends.
 */
export const recordEnded = (ended: { readonly session: string; readonly member: string }) =>
	Effect.flatMap(EventOutbox.Service, (outbox) =>
		transaction(outbox.publish([sessionEnded(ended)])),
	);

const sessionEnded = (ended: { readonly session: string; readonly member: string }) => ({
	stream: memberStream(ended.member),
	event: streamEvent("session.ended", { sessionId: ended.session }),
});

/**
 * The token of an `Authorization: Bearer` header: the session's token, as
 * better-auth's bearer plugin hands it out. `undefined` when there is no such
 * header, so the cookie is read instead.
 */
function bearerTokenIn(headers: Headers): string | undefined {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
	return match?.[1];
}

/** No session, an expired or revoked one, or a token or cookie that names none. */
export class SessionInvalid
	extends Schema.TaggedError<SessionInvalid>()("SessionInvalid", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The request carries no unexpired session";
	}
	get userMessage() {
		return userText`You're signed out. Sign in again to carry on`;
	}
}

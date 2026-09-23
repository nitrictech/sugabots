import { createMiddleware } from "hono/factory";
import { API_BASE_PATH } from "../config.ts";
import { HttpError } from "../http/errors.ts";
import type { Session, SessionResolver } from "./session.ts";

/**
 * Bearer authentication for native and script clients, or a Better Auth cookie
 * session for browsers. An explicit Authorization header never falls back to a
 * cookie if malformed or expired.
 */

export interface AuthEnv {
	Variables: {
		session: Session;
	};
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects a cookie-authenticated write whose Origin is not in `trustedOrigins`,
 * which is what stops CSRF. Routes under `/auth` and `/hooks` are exempt:
 * better-auth checks for itself, and webhooks carry no browser cookie.
 */
export function requireCookieOrigin(trustedOrigins: string[]) {
	const trusted = new Set(trustedOrigins);
	const exempt = [`${API_BASE_PATH}/auth/`, `${API_BASE_PATH}/hooks/`];
	return createMiddleware(async (c, next) => {
		if (
			SAFE_METHODS.has(c.req.method) ||
			exempt.some((prefix) => c.req.path.startsWith(prefix)) ||
			!c.req.header("cookie") ||
			bearerToken(c.req.header("authorization"))
		) {
			await next();
			return;
		}

		const origin = c.req.header("origin");
		if (!origin || !trusted.has(origin)) {
			throw new HttpError("forbidden", "Untrusted request origin");
		}
		await next();
	});
}

/** Rejects the request unless its bearer token or cookie resolves to a session. */
export function requireSession(resolve: SessionResolver) {
	return createMiddleware<AuthEnv>(async (c, next) => {
		const authorization = c.req.header("authorization");
		let headers = c.req.raw.headers;
		if (authorization !== undefined) {
			const token = bearerToken(authorization);
			if (!token) {
				throw new HttpError("unauthorized", "Invalid Authorization header");
			}
			headers = new Headers({ authorization: `Bearer ${token}` });
		}

		const session = await resolve(headers);
		if (!session) {
			throw new HttpError("unauthorized", "Invalid or expired session");
		}

		c.set("session", session);
		await next();
	});
}

export function bearerToken(header: string | undefined): string | undefined {
	const [scheme, ...rest] = header?.trim().split(/\s+/) ?? [];
	if (scheme?.toLowerCase() !== "bearer") {
		return undefined;
	}
	return rest.join(" ") || undefined;
}

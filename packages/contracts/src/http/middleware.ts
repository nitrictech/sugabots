import { Context } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import type { SessionUser } from "../api.ts";
import { BadRequest, InternalServerError, PayloadTooLarge, Unauthorized } from "./errors.ts";

/** The person whose bearer token or cookie the request carried. */
export class CurrentUser extends Context.Service<CurrentUser, SessionUser>()(
	"sugabots/http/CurrentUser",
) {}

/**
 * The session the request's credentials belong to, one signed-in browser or
 * app, and how the request carried them: a browser's cookie, or the bearer
 * token the apps sign in with.
 */
export class CurrentSession extends Context.Service<
	CurrentSession,
	{ readonly id: string; readonly credential: "cookie" | "bearer" }
>()("sugabots/http/CurrentSession") {}

/**
 * Refuses the request unless its credentials resolve to a session.
 *
 * Not required of the client: a browser's cookie travels on its own, and the
 * SDK adds a bearer token to every request rather than per endpoint.
 */
export class Session extends HttpApiMiddleware.Service<
	Session,
	{ provides: CurrentUser | CurrentSession }
>()("sugabots/http/Session", { error: Unauthorized }) {}

/**
 * Answers a request that fails its endpoint's schemas with `BadRequest`, in
 * the API's own error shape rather than as an empty response.
 *
 * It also declares the failures every endpoint can answer with before its own
 * code runs — a body over the limit, a server fault — so the client decodes
 * those too.
 */
export class ValidateRequest extends HttpApiMiddleware.Service<ValidateRequest>()(
	"sugabots/http/ValidateRequest",
	{ error: [BadRequest, PayloadTooLarge, InternalServerError] },
) {}

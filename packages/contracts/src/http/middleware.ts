import { Context } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import type { CurrentUser } from "../api.ts";
import { Tier } from "../tiers.ts";
import { BadRequest, InternalServerError, PayloadTooLarge, Unauthorized } from "./errors.ts";

/** The member whose session cookie the request carried. */
export class CurrentUserOfRequest extends Context.Service<CurrentUserOfRequest, CurrentUser>()(
	"sugabots/http/CurrentUserOfRequest",
) {
	declare readonly [Tier]: "request";
}

/**
 * Refuses the request unless its credentials resolve to a session.
 *
 * Not required of the client: a browser's session cookie travels on its own.
 */
export class Session extends HttpApiMiddleware.Service<
	Session,
	{ provides: CurrentUserOfRequest }
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

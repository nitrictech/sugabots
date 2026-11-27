import { Context } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import type { CurrentUser } from "../api.ts";
import { Tier } from "../tiers.ts";
import {
	BadRequest,
	Forbidden,
	InternalServerError,
	PayloadTooLarge,
	Unauthorized,
	UnsupportedMediaType,
} from "./errors.ts";

/** The member whose session cookie the request carried. */
export class CurrentUserOfRequest extends Context.Service<CurrentUserOfRequest, CurrentUser>()(
	"sugabots/http/CurrentUserOfRequest",
) {
	declare readonly [Tier]: "request";
}

/**
 * What the server's session check found for the request, beyond the member:
 * what it calls operations with. Empty here, where nothing reads it; the
 * server fills it in by augmenting this interface, since its parts are core's
 * types, which this package can't name.
 */
// biome-ignore lint/suspicious/noEmptyInterface: the server augments it with its fields.
export interface RequestAuthentication {}

/**
 * The request `Session` authenticated. A handler that needs it says so in its
 * type, and only an endpoint behind `Session` is given it.
 */
export class AuthenticatedRequest extends Context.Service<
	AuthenticatedRequest,
	RequestAuthentication
>()("sugabots/http/AuthenticatedRequest") {
	declare readonly [Tier]: "request";
}

/**
 * Refuses the request unless its credentials resolve to a session.
 *
 * Not required of the client: a browser's session cookie travels on its own.
 */
export class Session extends HttpApiMiddleware.Service<
	Session,
	{ provides: CurrentUserOfRequest | AuthenticatedRequest }
>()("sugabots/http/Session", { error: Unauthorized }) {}

/**
 * Answers a request that fails its endpoint's schemas with `BadRequest`, in
 * the API's own error shape rather than as an empty response.
 *
 * It also declares the failures every endpoint can answer with before its own
 * code runs, so the client decodes those too: a body over the limit or of a
 * type the endpoint does not take, a cookie-authenticated write from an
 * untrusted origin, and a server fault.
 */
export class ValidateRequest extends HttpApiMiddleware.Service<ValidateRequest>()(
	"sugabots/http/ValidateRequest",
	{ error: [BadRequest, Forbidden, PayloadTooLarge, UnsupportedMediaType, InternalServerError] },
) {}

/**
 * The largest body, in bytes, an endpoint that parses JSON reads, where it
 * reads more than the API's usual limit: an annotation on the endpoint, which
 * `ValidateRequest` enforces while the body is read.
 */
export class MaxBodyBytes extends Context.Service<MaxBodyBytes, number>()(
	"sugabots/http/MaxBodyBytes",
) {
	declare readonly [Tier]: "process";
}

/**
 * The largest delivery a GitHub connector reads, in bytes: GitHub sends
 * deliveries of up to 25 MiB. What reaches an automation from one is the
 * activity it describes, with its text cut short, not the delivery itself.
 */
export const GITHUB_DELIVERY_MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * The largest call an automation's webhook reads, in bytes. Its whole body
 * goes into the run's first message as trigger data, and so into every model
 * request the run makes; 64 KiB, about 16,000 tokens, leaves room beside it
 * in any model's context window for the instructions, the run's own work and
 * its tool results.
 */
export const AUTOMATION_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

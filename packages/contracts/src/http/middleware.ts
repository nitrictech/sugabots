import { Context } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import type { SessionUser } from "../api.ts";
import type { PodPermission, WorkspacePermission } from "../permissions.ts";
import {
	BadRequest,
	Forbidden,
	InternalServerError,
	NotFound,
	PayloadTooLarge,
	Unauthorized,
} from "./errors.ts";

/** The person whose bearer token or cookie the request carried. */
export class CurrentUser extends Context.Service<CurrentUser, SessionUser>()(
	"sugabots/http/CurrentUser",
) {}

/**
 * Refuses the request unless its credentials resolve to a session.
 *
 * Not required of the client: a browser's cookie travels on its own, and the
 * SDK adds a bearer token to every request rather than per endpoint.
 */
export class Session extends HttpApiMiddleware.Service<Session, { provides: CurrentUser }>()(
	"sugabots/http/Session",
	{ error: Unauthorized },
) {}

/**
 * What an endpoint lets the caller do, declared on the endpoint itself.
 *
 * `workspace`, `pod` and `agent` name the permission to check against the
 * `:workspaceId`, `:podId` or `:agentId` in the path. `reach` is for an
 * endpoint addressed at something narrower — a thread, a chat, a turn — whose
 * store scopes the query to the pods the caller reaches; the string says
 * where, because that claim has to stay true.
 */
export type AccessRule =
	| { readonly workspace: WorkspacePermission }
	| { readonly pod: PodPermission }
	| { readonly agent: PodPermission }
	| { readonly reach: string };

/** The annotation `Authorise` reads. Every endpoint behind `Session` carries one. */
export class Access extends Context.Service<Access, AccessRule>()("sugabots/http/Access") {}

/**
 * Checks the endpoint's `Access` rule before its request is decoded.
 *
 * Anything the caller cannot reach is `NotFound`, never `Forbidden`, because
 * `Forbidden` confirms an id exists. `Forbidden` is for something the caller
 * can see and is refused an action on.
 */
export class Authorise extends HttpApiMiddleware.Service<Authorise, { requires: CurrentUser }>()(
	"sugabots/http/Authorise",
	{ error: [NotFound, Forbidden] },
) {}

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

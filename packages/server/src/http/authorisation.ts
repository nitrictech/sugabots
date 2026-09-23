import type { Database } from "@sugabots/core/database/database";
import type {
	AgentStanding,
	Authorization,
	AuthorizationDenied,
	PodStanding,
	ResourceHidden,
	WorkspaceStanding,
} from "@sugabots/core/workspaces/access";
import type { PodPermission, WorkspacePermission } from "@sugabots/core/workspaces/permissions";
import type { Effect } from "effect";
import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "../auth/middleware.ts";
import { asHttpError, HttpError } from "./errors.ts";
import type { RunHandler } from "./handler.ts";

/**
 * Authorisation middleware for workspace-, pod- and agent-addressed routes.
 *
 * Each reads its route parameter, names the action the route performs, and
 * asks `Authorization` whether the caller may take it. Naming the action is
 * not optional: a route cannot be registered without saying what it does, so
 * "which permission is this?" is answered at the route table rather than
 * inside a handler. The name is also left on the middleware, which is how
 * `authorisation.test.ts` asks the router which routes authorise anything
 * instead of trusting a list kept by hand.
 *
 * Each declares its own Hono environment, so a handler that reads
 * `c.get("pod")` does not compile unless `requirePod` is in that route's
 * chain: forgetting the check is a build failure rather than a hole.
 *
 * Anything the caller cannot reach is `not_found`, never `forbidden`, because
 * `forbidden` confirms that an id exists and lets a stranger enumerate them.
 * `forbidden` is used only where the caller can already see the thing and is
 * being refused an action on it.
 */

export interface WorkspaceEnv extends AuthEnv {
	Variables: AuthEnv["Variables"] & {
		/** The workspace named by `:workspaceId`, and the caller's standing in it. */
		workspace: WorkspaceStanding;
	};
}

export interface PodEnv extends AuthEnv {
	Variables: AuthEnv["Variables"] & {
		/** The pod named by `:podId`, and the caller's standing in it. */
		pod: PodStanding;
	};
}

export interface AgentEnv extends AuthEnv {
	Variables: AuthEnv["Variables"] & {
		/** The agent named by `:agentId`, and the caller's standing towards it. */
		agent: AgentStanding;
	};
}

/** `:workspaceId` must name a workspace where the caller may take `permission`. */
export function requireWorkspace(
	authorization: Authorization,
	run: RunHandler,
	permission: WorkspacePermission,
) {
	return naming(
		createMiddleware<WorkspaceEnv>(async (c, next) => {
			const id = required(c.req.param("workspaceId"), "Workspace id required");
			c.set(
				"workspace",
				await allowed(run, authorization.workspace(c.get("session").user.id, id, permission)),
			);
			await next();
		}),
		permission,
	);
}

/** `:podId` must name a pod where the caller may take `permission`. */
export function requirePod(
	authorization: Authorization,
	run: RunHandler,
	permission: PodPermission,
) {
	return naming(
		createMiddleware<PodEnv>(async (c, next) => {
			const id = required(c.req.param("podId"), "Pod id required");
			c.set("pod", await allowed(run, authorization.pod(c.get("session").user.id, id, permission)));
			await next();
		}),
		permission,
	);
}

/** `:agentId` must name an agent whose pod lets the caller take `permission`. */
export function requireAgent(
	authorization: Authorization,
	run: RunHandler,
	permission: PodPermission,
) {
	return naming(
		createMiddleware<AgentEnv>(async (c, next) => {
			const id = required(c.req.param("agentId"), "Agent id required");
			c.set(
				"agent",
				await allowed(run, authorization.agent(c.get("session").user.id, id, permission)),
			);
			await next();
		}),
		permission,
	);
}

type Permission = WorkspacePermission | PodPermission;

function naming<Middleware extends object>(
	middleware: Middleware,
	requiredPermission: Permission,
): Middleware {
	return Object.assign(middleware, { requiredPermission });
}

/** The permission a route handler requires, when it is one of the middlewares here. */
export function permissionRequiredBy(handler: unknown): Permission | undefined {
	if (typeof handler !== "function" || !("requiredPermission" in handler)) return undefined;
	return (handler as { requiredPermission: Permission }).requiredPermission;
}

function required(value: string | undefined, absent: string): string {
	if (!value) {
		throw new HttpError("bad_request", absent);
	}
	return value;
}

/** What each way authorisation can refuse means over HTTP. */
function allowed<Standing>(
	run: RunHandler,
	decision: Effect.Effect<Standing, AuthorizationDenied, Database>,
): Promise<Standing> {
	return run(decision.pipe(asHttpError(denials)));
}

const denials = {
	ResourceHidden: (hidden: ResourceHidden) => new HttpError("not_found", hidden.message),
	ActionForbidden: () => new HttpError("forbidden", "You are not allowed to do that"),
};

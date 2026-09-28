import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { healthResponseSchema, sessionUserSchema } from "../../api.ts";
import {
	workspaceIdOrSlugSchema,
	workspacePermissionsSchema,
	workspaceRoleSchema,
} from "../../workspaces.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/** Liveness, and who the caller is. */
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
	HttpApiEndpoint.get("health", "/health", { success: healthResponseSchema }),
	HttpApiEndpoint.get("me", "/me", { success: sessionUserSchema }).middleware(Session),
	// What the caller may do in one workspace, so the web app can decide
	// whether to draw a control at all rather than let it fail. The role is
	// here too, because a settings screen says which one somebody holds.
	HttpApiEndpoint.get("workspaceAccess", "/workspaces/:workspace/me", {
		params: { workspace: workspaceIdOrSlugSchema },
		success: Schema.Struct({
			/** Always present past `workspace.read`, which no role-less caller holds. */
			role: Schema.optional(workspaceRoleSchema),
			permissions: workspacePermissionsSchema,
		}),
		error: refused,
	}).middleware(Session),
) {}

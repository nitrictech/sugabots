import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { healthResponseSchema, sessionUserSchema } from "../../api.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspacePermissionsSchema, workspaceRoleSchema } from "../../workspaces.ts";
import { Access, Authorise, Session } from "../middleware.ts";

/** Liveness, and who the caller is. */
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
	HttpApiEndpoint.get("health", "/health", { success: healthResponseSchema }),
	HttpApiEndpoint.get("me", "/me", { success: sessionUserSchema })
		.annotate(Access, { reach: "the signed-in person, and nothing about a workspace" })
		.middleware(Authorise)
		.middleware(Session),
	// What the caller may do in one workspace, so the web app can decide
	// whether to draw a control at all rather than let it fail. The role is
	// here too, because a settings screen says which one somebody holds.
	HttpApiEndpoint.get("workspaceAccess", "/workspaces/:workspaceId/me", {
		params: { workspaceId: uuidSchema },
		success: Schema.Struct({
			/** Always present past `workspace.read`, which no role-less caller holds. */
			role: Schema.optional(workspaceRoleSchema),
			permissions: workspacePermissionsSchema,
		}),
	})
		.annotate(Access, { workspace: "workspace.read" })
		.middleware(Authorise)
		.middleware(Session),
) {}

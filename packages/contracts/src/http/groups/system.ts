import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { currentUserSchema, healthResponseSchema, memberNameSchema } from "../../api.ts";
import { meSchema } from "../../me.ts";
import { workspaceAccessSchema, workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/** Liveness, and who the caller is. */
export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
	HttpApiEndpoint.get("health", "/health", { success: healthResponseSchema }),
	HttpApiEndpoint.get("me", "/me", { success: meSchema }).middleware(Session),
	/** Changes the caller's own name, which other members see and which makes their handle. */
	HttpApiEndpoint.patch("rename", "/me", {
		payload: Schema.Struct({ name: memberNameSchema }),
		success: currentUserSchema,
	}).middleware(Session),
	HttpApiEndpoint.get("workspaceAccess", "/workspaces/:workspace/me", {
		params: { workspace: workspaceIdOrSlugSchema },
		success: workspaceAccessSchema,
		error: refused,
	}).middleware(Session),
) {}

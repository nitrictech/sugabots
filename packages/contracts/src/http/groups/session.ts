import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { currentUserSchema, healthResponseSchema, memberNameSchema } from "../../api.ts";
import { meSchema } from "../../me.ts";
import { Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";
import { ServedOperation } from "../served.ts";

/**
 * Liveness, which needs nobody signed in and so is no operation, and the
 * member the session is for. Written by hand: `me` reads the session's row
 * and lists the member's workspaces in one answer, and `rename` renews the
 * session's cookie, which caches the member's name.
 */
export class SessionApi extends HttpApiGroup.make("session", { topLevel: true }).add(
	HttpApiEndpoint.get("health", "/health", { success: healthResponseSchema }),
	/** Who is signed in, read from their session itself rather than any cache of it. */
	HttpApiEndpoint.get("me", "/me", { success: meSchema, error: Unauthorized }).middleware(Session),
	/** Changes the caller's own name, which other members see and which makes their handle. */
	HttpApiEndpoint.patch("rename", "/me", {
		payload: Schema.Struct({ name: memberNameSchema }),
		success: currentUserSchema,
	})
		.middleware(Session)
		.annotate(ServedOperation, "system.rename"),
) {}

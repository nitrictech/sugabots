import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { usageQuerySchema, workspaceUsageSchema } from "../../usage.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * What the workspace's models cost. Admin only: it shows every pod's and every
 * bot's spend, personal pods included.
 */
export class UsageApi extends HttpApiGroup.make("usage")
	.add(
		HttpApiEndpoint.get("month", "/workspaces/:workspace/usage", {
			params: { workspace: workspaceIdOrSlugSchema },
			query: usageQuerySchema,
			success: workspaceUsageSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

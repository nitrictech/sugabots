import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { systemBotSchema, systemBotUpdateSchema } from "../../system-bots.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * The workspace's system bots, such as Compaction: what they are, and the
 * model each runs on.
 *
 * Addressed by key rather than by id, because there is exactly one of each per
 * workspace. That is also what keeps this from being pointed at a bot people talk to,
 * which is configured in its own settings instead.
 *
 * Reading is open to the whole workspace: what is exposed is names and model
 * ids, which a member already sees on every bot they can see.
 */
export class SystemBotsApi extends HttpApiGroup.make("systemBots")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/system-bots", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(systemBotSchema),
			error: refused,
		}),
		// The key is a string here rather than `systemBotKeySchema`, so a key
		// that names no system bot is `NotFound` like any other missing thing,
		// not a malformed request.
		HttpApiEndpoint.patch("update", "/workspaces/:workspace/system-bots/:key", {
			params: { workspace: workspaceIdOrSlugSchema, key: Schema.String },
			payload: systemBotUpdateSchema,
			success: systemBotSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

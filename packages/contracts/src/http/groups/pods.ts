import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { agentSchema } from "../../agents.ts";
import {
	newPodMemberSchema,
	newPodSchema,
	podMemberSchema,
	podSchema,
	podUpdateSchema,
} from "../../pods.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * Channels, who is in them, and their bots. `list` answers the channels the
 * caller is in and the public ones they could join, as the directory shows.
 */
export class PodsApi extends HttpApiGroup.make("pods")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/pods", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(podSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/pods", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newPodSchema,
			success: podSchema.pipe(HttpApiSchema.status(201)),
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("update", "/pods/:podId", {
			params: { podId: uuidSchema },
			payload: podUpdateSchema,
			success: podSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", "/pods/:podId", {
			params: { podId: uuidSchema },
			error: refused,
		}),
		HttpApiEndpoint.get("listMembers", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			success: Schema.Array(podMemberSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addMember", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			payload: newPodMemberSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("removeMember", "/pods/:podId/members/:userId", {
			params: { podId: uuidSchema, userId: Schema.String },
			error: refused,
		}),
		/** Takes the caller out of the channel. */
		HttpApiEndpoint.delete("leave", "/pods/:podId/membership", {
			params: { podId: uuidSchema },
			error: refused,
		}),
		/** Puts the caller in a public channel. */
		HttpApiEndpoint.put("join", "/pods/:podId/membership", {
			params: { podId: uuidSchema },
			success: podSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("listBots", "/pods/:podId/agents", {
			params: { podId: uuidSchema },
			success: Schema.Array(agentSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addBot", "/pods/:podId/agents", {
			params: { podId: uuidSchema },
			payload: Schema.Struct({ agentId: uuidSchema }),
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeBot", "/pods/:podId/agents/:agentId", {
			params: { podId: uuidSchema, agentId: uuidSchema },
			error: refused,
		}),
	)
	.middleware(Session) {}

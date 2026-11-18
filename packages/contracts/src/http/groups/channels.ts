import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { botSchema } from "../../bots.ts";
import {
	channelMemberSchema,
	channelSchema,
	channelUpdateSchema,
	newChannelMemberSchema,
	newChannelSchema,
} from "../../channels.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * Channels, who is in them, and their bots. `list` answers the channels the
 * caller is in and the public ones they could join, as the directory shows.
 */
export class ChannelsApi extends HttpApiGroup.make("channels")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/channels", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(channelSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/channels", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newChannelSchema,
			success: channelSchema.pipe(HttpApiSchema.status(201)),
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("update", "/channels/:channelId", {
			params: { channelId: uuidSchema },
			payload: channelUpdateSchema,
			success: channelSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", "/channels/:channelId", {
			params: { channelId: uuidSchema },
			error: refused,
		}),
		HttpApiEndpoint.get("listMembers", "/channels/:channelId/members", {
			params: { channelId: uuidSchema },
			success: Schema.Array(channelMemberSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addMember", "/channels/:channelId/members", {
			params: { channelId: uuidSchema },
			payload: newChannelMemberSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("removeMember", "/channels/:channelId/members/:userId", {
			params: { channelId: uuidSchema, userId: Schema.String },
			error: refused,
		}),
		/** Takes the caller out of the channel. */
		HttpApiEndpoint.delete("leave", "/channels/:channelId/membership", {
			params: { channelId: uuidSchema },
			error: refused,
		}),
		/** Puts the caller in a public channel. */
		HttpApiEndpoint.put("join", "/channels/:channelId/membership", {
			params: { channelId: uuidSchema },
			success: channelSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("listBots", "/channels/:channelId/bots", {
			params: { channelId: uuidSchema },
			success: Schema.Array(botSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addBot", "/channels/:channelId/bots", {
			params: { channelId: uuidSchema },
			payload: Schema.Struct({ botId: uuidSchema }),
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeBot", "/channels/:channelId/bots/:botId", {
			params: { channelId: uuidSchema, botId: uuidSchema },
			error: refused,
		}),
	)
	.middleware(Session) {}

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	activityFeedSchema,
	approvalInboxSchema,
	chatHistoryPageSchema,
	chatListQuerySchema,
	chatListSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
	chatSchema,
	getOrCreateChatSchema,
	podChatMarkersSchema,
} from "../../chats.ts";
import { messageSchema, newMessageSchema } from "../../threads.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class ChatsApi extends HttpApiGroup.make("chats")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/chats", {
			params: { workspace: workspaceIdOrSlugSchema },
			query: chatListQuerySchema,
			success: chatListSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("podMarkers", "/workspaces/:workspace/chats/pod-markers", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: podChatMarkersSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("activity", "/workspaces/:workspace/chats/activity", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: activityFeedSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("approvals", "/workspaces/:workspace/chats/approvals", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: approvalInboxSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("getOrCreate", "/workspaces/:workspace/chats", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: getOrCreateChatSchema,
			success: chatSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("messages", "/chats/:chatId/messages", {
			params: { chatId: Schema.String },
			query: chatPageQuerySchema,
			success: chatMessagesPageSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("history", "/chats/:chatId/history", {
			params: { chatId: Schema.String },
			query: chatPageQuerySchema,
			success: chatHistoryPageSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("markRead", "/chats/:chatId/read", {
			params: { chatId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.post("send", "/chats/:chatId/messages", {
			params: { chatId: Schema.String },
			payload: newMessageSchema,
			success: messageSchema.pipe(HttpApiSchema.status(201)),
			error: [Conflict, ...refused],
		}),
	)
	.middleware(Session) {}

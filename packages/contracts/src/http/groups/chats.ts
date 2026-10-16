import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { uploadAttachmentQuerySchema, uploadedAttachmentSchema } from "../../attachments.ts";
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
import { BadRequest, Conflict, PayloadTooLarge, refused } from "../errors.ts";
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
			error: [BadRequest, Conflict, ...refused],
		}),
		/**
		 * Uploads a file to attach to a message the caller then sends. The body
		 * is the file's bytes, and `Content-Type` its media type.
		 */
		HttpApiEndpoint.post("uploadFile", "/chats/:chatId/files", {
			params: { chatId: Schema.String },
			query: uploadAttachmentQuerySchema,
			payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
			success: uploadedAttachmentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, PayloadTooLarge, Conflict, ...refused],
		}),
		/**
		 * Removes one of the caller's uploads before it is sent. Removing one
		 * already gone, sent, or someone else's changes nothing.
		 */
		HttpApiEndpoint.delete("removeFile", "/chats/:chatId/files/:fileId", {
			params: { chatId: Schema.String, fileId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		/** A file attached to a message in the chat, with its own media type. */
		HttpApiEndpoint.get("file", "/chats/:chatId/files/:fileId", {
			params: { chatId: Schema.String, fileId: Schema.String },
			success: HttpApiSchema.StreamUint8Array(),
			error: refused,
		}),
	)
	.middleware(Session) {}

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { uploadAttachmentQuerySchema, uploadedAttachmentSchema } from "../../attachments.ts";
import {
	attentionCountsSchema,
	attentionMarksSchema,
	automationFeedSchema,
	chatHistoryPageSchema,
	chatMessagesPageSchema,
	chatNameSchema,
	chatPageQuerySchema,
	firstChatMessageSchema,
	projectChatListSchema,
	projectChatSchema,
	startedChatSchema,
	workspaceApprovalsSchema,
} from "../../chats.ts";
import {
	chatContextSchema,
	chatDetailsSchema,
	chatHistoryQuerySchema,
	messageReactionsSchema,
	messageSchema,
	newMessageSchema,
	reactionEmojiSchema,
} from "../../messages.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, PayloadTooLarge, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class ChatsApi extends HttpApiGroup.make("chats")
	.add(
		/** A project's chats and automations: a bot's are its default project's. */
		HttpApiEndpoint.get("projectChats", "/projects/:projectId/chats", {
			params: { projectId: Schema.String },
			success: projectChatListSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("attention", "/workspaces/:workspace/chats/attention", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: attentionCountsSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("attentionMarks", "/workspaces/:workspace/chats/attention-marks", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: attentionMarksSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("approvals", "/workspaces/:workspace/chats/approvals", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: workspaceApprovalsSchema,
			error: refused,
		}),
		/**
		 * Starts the chat in which a bot the caller just made interviews them to
		 * write its own instructions. Null when the bot is not due one.
		 */
		HttpApiEndpoint.post("startInterview", "/bots/:botId/interview", {
			params: { botId: Schema.String },
			success: Schema.NullOr(projectChatSchema),
			error: refused,
		}),
		/** The automation's feed, where its runs post, opened on first use. */
		HttpApiEndpoint.post(
			"openAutomationFeed",
			"/workspaces/:workspace/automations/:automationId/feed",
			{
				params: { workspace: workspaceIdOrSlugSchema, automationId: Schema.String },
				success: automationFeedSchema,
				error: refused,
			},
		),
		/**
		 * Starts a chat in the project, for everyone in it, with its first
		 * message. A bot's chat is started in its default project.
		 */
		HttpApiEndpoint.post("startProjectChat", "/projects/:projectId/chats", {
			params: { projectId: Schema.String },
			payload: firstChatMessageSchema,
			success: startedChatSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		/** Renames one of the project's chats. */
		HttpApiEndpoint.put("renameChat", "/chats/:chatId/name", {
			params: { chatId: Schema.String },
			payload: chatNameSchema,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, ...refused],
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
		/** Marks the project's chat resolved. Any other chat is hidden from this. */
		HttpApiEndpoint.put("markResolved", "/chats/:chatId/resolved", {
			params: { chatId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		/** Reopens a project's chat marked resolved. Any other chat is hidden from this. */
		HttpApiEndpoint.delete("reopen", "/chats/:chatId/resolved", {
			params: { chatId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.post("markRead", "/chats/:chatId/read", {
			params: { chatId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		/**
		 * Reads one automation run or collaboration, by its own chat, and
		 * nothing else in the chat it is in.
		 */
		HttpApiEndpoint.post("markNestedChatRead", "/nested-chats/:chatId/read", {
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
		// HEAD answers the same with a one-message page, for asking whether the
		// chat is there without its history.
		HttpApiEndpoint.get("get", "/chats/:chatId", {
			params: { chatId: Schema.String },
			query: chatHistoryQuerySchema,
			success: chatDetailsSchema,
			error: refused,
		}),
		// Null until a reply in the chat has been measured.
		HttpApiEndpoint.get("context", "/chats/:chatId/context", {
			params: { chatId: Schema.String },
			success: Schema.NullOr(chatContextSchema),
			error: refused,
		}),
		// Adding a reaction already there, or taking back one that is not, changes
		// nothing, so a retried request is safe. Both answer with what the message has now.
		HttpApiEndpoint.put("react", "/messages/:messageId/reactions/:emoji", {
			params: { messageId: Schema.String, emoji: reactionEmojiSchema },
			success: messageReactionsSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("unreact", "/messages/:messageId/reactions/:emoji", {
			params: { messageId: Schema.String, emoji: reactionEmojiSchema },
			success: messageReactionsSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { uploadAttachmentQuerySchema, uploadedAttachmentSchema } from "../../attachments.ts";
import {
	approvalInboxSchema,
	automationFeedSchema,
	botThreadListSchema,
	chatHistoryPageSchema,
	chatListQuerySchema,
	chatListSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
	directMessageListItemSchema,
	directMessageListSchema,
	firstThreadMessageSchema,
	inboxFeedSchema,
	newDirectMessageSchema,
	projectThreadMarkersSchema,
	projectThreadSchema,
	sentDirectMessageSchema,
	startedThreadSchema,
	threadNameSchema,
} from "../../chats.ts";
import { messageSchema, newMessageSchema } from "../../conversations.ts";
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
		HttpApiEndpoint.get("projectMarkers", "/workspaces/:workspace/chats/project-markers", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: projectThreadMarkersSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("inbox", "/workspaces/:workspace/chats/inbox", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: inboxFeedSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("approvals", "/workspaces/:workspace/chats/approvals", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: approvalInboxSchema,
			error: refused,
		}),
		/** A bot's threads, which are its default project's, and its automations. */
		HttpApiEndpoint.get("botThreads", "/bots/:botId/threads", {
			params: { botId: Schema.String },
			success: botThreadListSchema,
			error: refused,
		}),
		/** Starts a thread with a bot, with its first message. */
		HttpApiEndpoint.post("startThread", "/bots/:botId/threads", {
			params: { botId: Schema.String },
			payload: firstThreadMessageSchema,
			success: startedThreadSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		/**
		 * Starts the thread in which a bot the caller just made interviews them to
		 * write its own instructions. Null when the bot is not due one.
		 */
		HttpApiEndpoint.post("startInterview", "/bots/:botId/interview", {
			params: { botId: Schema.String },
			success: Schema.NullOr(projectThreadSchema),
			error: refused,
		}),
		/** The caller's direct messages with other people, the most recent first. */
		HttpApiEndpoint.get("directMessages", "/workspaces/:workspace/direct-messages", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: directMessageListSchema,
			error: refused,
		}),
		/**
		 * Sends a message to other people in the workspace, in the caller's direct
		 * message with them, which is opened if they have none.
		 */
		HttpApiEndpoint.post("sendDirectMessage", "/workspaces/:workspace/direct-messages", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newDirectMessageSchema,
			success: sentDirectMessageSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		/** One of the caller's direct messages, as their list shows it. */
		HttpApiEndpoint.get("directMessage", "/direct-messages/:conversationId", {
			params: { conversationId: Schema.String },
			success: directMessageListItemSchema,
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
		/** Starts a thread in the project, for everyone in it, with its first message. */
		HttpApiEndpoint.post("startProjectThread", "/projects/:projectId/threads", {
			params: { projectId: Schema.String },
			payload: firstThreadMessageSchema,
			success: startedThreadSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		/** Starts a thread in the project, for everyone in it, called what it is given. */
		HttpApiEndpoint.post("startNamedThread", "/projects/:projectId/chats", {
			params: { projectId: Schema.String },
			payload: threadNameSchema,
			success: projectThreadSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, ...refused],
		}),
		/** Renames one of the project's threads that is not archived. */
		HttpApiEndpoint.put("renameThread", "/conversations/:conversationId/name", {
			params: { conversationId: Schema.String },
			payload: threadNameSchema,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, Conflict, ...refused],
		}),
		/** Archives one of the project's threads, which hides it from the project's list. */
		HttpApiEndpoint.put("archiveThread", "/conversations/:conversationId/archived", {
			params: { conversationId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.get("messages", "/conversations/:conversationId/messages", {
			params: { conversationId: Schema.String },
			query: chatPageQuerySchema,
			success: chatMessagesPageSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("history", "/conversations/:conversationId/history", {
			params: { conversationId: Schema.String },
			query: chatPageQuerySchema,
			success: chatHistoryPageSchema,
			error: refused,
		}),
		/** Marks the project thread done. Any other conversation is hidden from this. */
		HttpApiEndpoint.put("markDone", "/conversations/:conversationId/done", {
			params: { conversationId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		/** Reopens a project thread marked done. Any other conversation is hidden from this. */
		HttpApiEndpoint.delete("reopen", "/conversations/:conversationId/done", {
			params: { conversationId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.post("markRead", "/conversations/:conversationId/read", {
			params: { conversationId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		/**
		 * Reads one automation run or collaboration, by its own conversation, and
		 * nothing else in the conversation it is in.
		 */
		HttpApiEndpoint.post("markItemRead", "/items/:conversationId/read", {
			params: { conversationId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.post("send", "/conversations/:conversationId/messages", {
			params: { conversationId: Schema.String },
			payload: newMessageSchema,
			success: messageSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		/**
		 * Uploads a file to attach to a message the caller then sends. The body
		 * is the file's bytes, and `Content-Type` its media type.
		 */
		HttpApiEndpoint.post("uploadFile", "/conversations/:conversationId/files", {
			params: { conversationId: Schema.String },
			query: uploadAttachmentQuerySchema,
			payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
			success: uploadedAttachmentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, PayloadTooLarge, Conflict, ...refused],
		}),
		/**
		 * Removes one of the caller's uploads before it is sent. Removing one
		 * already gone, sent, or someone else's changes nothing.
		 */
		HttpApiEndpoint.delete("removeFile", "/conversations/:conversationId/files/:fileId", {
			params: { conversationId: Schema.String, fileId: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		/** A file attached to a message in the conversation, with its own media type. */
		HttpApiEndpoint.get("file", "/conversations/:conversationId/files/:fileId", {
			params: { conversationId: Schema.String, fileId: Schema.String },
			success: HttpApiSchema.StreamUint8Array(),
			error: refused,
		}),
	)
	.middleware(Session) {}

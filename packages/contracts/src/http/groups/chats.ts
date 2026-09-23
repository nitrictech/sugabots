import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	chatHistoryPageSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
	chatSchema,
	getOrCreateChatSchema,
} from "../../chats.ts";
import { messageSchema, newMessageSchema } from "../../threads.ts";
import { uuidSchema } from "../../uuid.ts";
import { Conflict } from "../errors.ts";
import { Access, Authorise, Session } from "../middleware.ts";

const scopedByVisibleChat = { reach: "chats/store.ts scopes by visibleChat" } as const;

export class ChatsApi extends HttpApiGroup.make("chats")
	.add(
		HttpApiEndpoint.post("getOrCreate", "/workspaces/:workspaceId/chats", {
			params: { workspaceId: uuidSchema },
			payload: getOrCreateChatSchema,
			success: chatSchema,
		}).annotate(Access, { workspace: "workspace.read" }),
		HttpApiEndpoint.get("messages", "/chats/:chatId/messages", {
			params: { chatId: Schema.String },
			query: chatPageQuerySchema,
			success: chatMessagesPageSchema,
		}).annotate(Access, scopedByVisibleChat),
		HttpApiEndpoint.get("history", "/chats/:chatId/history", {
			params: { chatId: Schema.String },
			query: chatPageQuerySchema,
			success: chatHistoryPageSchema,
		}).annotate(Access, scopedByVisibleChat),
		HttpApiEndpoint.post("send", "/chats/:chatId/messages", {
			params: { chatId: Schema.String },
			payload: newMessageSchema,
			success: messageSchema.pipe(HttpApiSchema.status(201)),
			error: Conflict,
		}).annotate(Access, scopedByVisibleChat),
	)
	.middleware(Authorise)
	.middleware(Session) {}

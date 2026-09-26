import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	chatHistoryPageSchema,
	chatListQuerySchema,
	chatListSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
	chatSchema,
	getOrCreateChatSchema,
} from "../../chats.ts";
import { messageSchema, newMessageSchema } from "../../threads.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

export class ChatsApi extends HttpApiGroup.make("chats")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/chats", {
			params: { workspace: workspaceIdOrSlugSchema },
			query: chatListQuerySchema,
			success: chatListSchema,
		}),
		HttpApiEndpoint.post("getOrCreate", "/workspaces/:workspace/chats", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: getOrCreateChatSchema,
			success: chatSchema,
		}),
		HttpApiEndpoint.get("messages", "/chats/:chatId/messages", {
			params: { chatId: Schema.String },
			query: chatPageQuerySchema,
			success: chatMessagesPageSchema,
		}),
		HttpApiEndpoint.get("history", "/chats/:chatId/history", {
			params: { chatId: Schema.String },
			query: chatPageQuerySchema,
			success: chatHistoryPageSchema,
		}),
		HttpApiEndpoint.post("send", "/chats/:chatId/messages", {
			params: { chatId: Schema.String },
			payload: newMessageSchema,
			success: messageSchema.pipe(HttpApiSchema.status(201)),
			error: Conflict,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}

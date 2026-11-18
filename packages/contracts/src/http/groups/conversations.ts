import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	conversationActivitySchema,
	conversationDetailsSchema,
	conversationHistoryQuerySchema,
	messageReactionsSchema,
	placedConversationSchema,
	reactionEmojiSchema,
} from "../../conversations.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class ConversationsApi extends HttpApiGroup.make("conversations")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/conversations", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(placedConversationSchema),
			error: refused,
		}),
		// HEAD answers the same with a one-message page, for asking whether the
		// conversation is there without its history.
		HttpApiEndpoint.get("get", "/conversations/:conversationId", {
			params: { conversationId: Schema.String },
			query: conversationHistoryQuerySchema,
			success: conversationDetailsSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("activity", "/conversations/:conversationId/activity", {
			params: { conversationId: Schema.String },
			success: conversationActivitySchema,
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
		HttpApiEndpoint.post("cancelTurn", "/turns/:turnId/cancel", {
			params: { turnId: Schema.String },
			success: HttpApiSchema.Empty(202),
			error: refused,
		}),
	)
	.middleware(Session) {}

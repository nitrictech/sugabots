import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	messageReactionsSchema,
	reactionEmojiSchema,
	threadActivitySchema,
	threadDetailsSchema,
	threadHistoryQuerySchema,
	threadSchema,
} from "../../threads.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class ThreadsApi extends HttpApiGroup.make("threads")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/threads", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(threadSchema),
			error: refused,
		}),
		// HEAD answers the same with a one-message page, for asking whether the
		// thread is there without its history.
		HttpApiEndpoint.get("get", "/threads/:threadId", {
			params: { threadId: Schema.String },
			query: threadHistoryQuerySchema,
			success: threadDetailsSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("activity", "/threads/:threadId/activity", {
			params: { threadId: Schema.String },
			success: threadActivitySchema,
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

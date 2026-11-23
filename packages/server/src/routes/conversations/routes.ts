import { BadRequest, Conflict } from "@sugabots/contracts/http";
import { ConversationView } from "@sugabots/core/conversations/conversation-view";
import { Reactions } from "@sugabots/core/conversations/reactions/reactions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const conversationRoutes = HttpApiBuilder.group(ServerApi, "conversations", (handlers) =>
	Effect.gen(function* () {
		const conversations = yield* ConversationView.Service;
		const reactions = yield* Reactions.Service;
		return handlers
			.handle("get", ({ params, query, request }) =>
				conversations
					.get(params.conversationId, request.method === "HEAD" ? { ...query, limit: 1 } : query)
					.pipe(asSessionUser, asHttpError(conversationErrors)),
			)
			.handle("activity", ({ params }) =>
				conversations
					.activity(params.conversationId)
					.pipe(asSessionUser, asHttpError(conversationErrors)),
			)
			.handle("react", ({ params }) =>
				reactions
					.add(params.messageId, params.emoji)
					.pipe(asSessionUser, asHttpError(conversationErrors)),
			)
			.handle("unreact", ({ params }) =>
				reactions
					.remove(params.messageId, params.emoji)
					.pipe(asSessionUser, asHttpError(conversationErrors)),
			);
	}),
);

const conversationErrors = {
	...refusals,
	InvalidConversationHistoryCursor: BadRequest,
	MessageNotFinished: Conflict,
	TooManyReactionEmoji: Conflict,
};

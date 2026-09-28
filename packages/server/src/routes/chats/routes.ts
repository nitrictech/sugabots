import { BadRequest, Conflict, CurrentUser, NotFound } from "@sugabots/contracts/http";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export const chatRoutes = HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		const view = yield* ChatView.Service;
		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
					const list = yield* view.list({ workspaceId, userId: actor.userId, pod: query.pod });
					return list ?? (yield* noSuchPod);
				}),
			)
			.handle("getOrCreate", ({ payload }) =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
					return yield* chats
						.open({ ...payload, workspaceId, userId: actor.userId })
						.pipe(asHttpError(chatErrors));
				}),
			)
			.handle("messages", ({ params, query }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const page = yield* view
						.messages(params.chatId, user.id, query)
						.pipe(asHttpError(chatErrors));
					return page ?? (yield* noSuchChat);
				}),
			)
			.handle("history", ({ params, query }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const page = yield* view
						.history(params.chatId, user.id, query)
						.pipe(asHttpError(chatErrors));
					return page ?? (yield* noSuchChat);
				}),
			)
			.handle("send", ({ params, payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const message = yield* chats
						.post({
							chatId: params.chatId,
							author: { id: user.id, name: user.name, image: user.image },
							messageId: payload.id,
							content: payload.message,
						})
						.pipe(asHttpError(chatErrors));
					return message ?? (yield* noSuchChat);
				}),
			);
	}),
);

const noSuchChat = new NotFound({ message: "No such chat" });
const noSuchPod = new NotFound({ message: "No such pod" });

const chatErrors = {
	ChatPlacementRejected: BadRequest,
	ChatMessageIdConflict: Conflict,
	ChatAgentHasNoModel: Conflict,
	InvalidChatCursor: BadRequest,
};

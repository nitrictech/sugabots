import { BadRequest, Conflict, CurrentUser, NotFound } from "@sugabots/contracts/http";
import type { ChatStore } from "@sugabots/core/conversations/chats/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface ChatRoutesOptions {
	chats: ChatStore;
}

export function chatRoutes({ chats }: ChatRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
		handlers
			.handle("getOrCreate", ({ payload }) =>
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* grantedWorkspace;
					return yield* chats
						.getOrCreate({ ...payload, workspaceId, userId: actor.userId })
						.pipe(asHttpError(chatErrors));
				}),
			)
			.handle("messages", ({ params, query }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const page = yield* chats
						.messages(params.chatId, user.id, query)
						.pipe(asHttpError(chatErrors));
					return page ?? (yield* noSuchChat);
				}),
			)
			.handle("history", ({ params, query }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const page = yield* chats
						.history(params.chatId, user.id, query)
						.pipe(asHttpError(chatErrors));
					return page ?? (yield* noSuchChat);
				}),
			)
			.handle("send", ({ params, payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const message = yield* chats
						.sendMain({
							chatId: params.chatId,
							userId: user.id,
							messageId: payload.id,
							content: payload.message,
						})
						.pipe(asHttpError(chatErrors));
					return message ?? (yield* noSuchChat);
				}),
			),
	);
}

const noSuchChat = new NotFound({ message: "No such chat" });

const chatErrors = {
	ChatPlacementRejected: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
	ChatMessageIdConflict: (failure: { message: string }) =>
		new Conflict({ message: failure.message }),
	ChatAgentHasNoModel: (failure: { message: string }) => new Conflict({ message: failure.message }),
	InvalidChatCursor: (failure: { message: string }) => new BadRequest({ message: failure.message }),
};

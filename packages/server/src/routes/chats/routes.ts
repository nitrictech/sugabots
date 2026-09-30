import { OPENED_CHAT_PAGE_LIMIT, OPENED_CHAT_THREAD_MESSAGES } from "@sugabots/contracts";
import { BadRequest, Conflict } from "@sugabots/contracts/http";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { ThreadView } from "@sugabots/core/conversations/thread-view";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const chatRoutes = HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		const view = yield* ChatView.Service;
		const threads = yield* ThreadView.Service;
		return (
			handlers
				.handle("list", ({ params, query }) =>
					view
						.list({ workspace: params.workspace, pod: query.pod })
						.pipe(asSessionUser, asHttpError(chatErrors)),
				)
				.handle("podMarkers", ({ params }) =>
					view.podMarkers(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
				)
				// The chat and what its screen draws first, so opening one is a single round trip.
				.handle("getOrCreate", ({ params, payload }) =>
					Effect.gen(function* () {
						const chat = yield* chats.open({ ...payload, workspace: params.workspace });
						const [mainThread, firstPage] = yield* Effect.all(
							[
								threads.get(chat.mainThreadId, { limit: OPENED_CHAT_THREAD_MESSAGES }),
								view.messages(chat.id, { limit: OPENED_CHAT_PAGE_LIMIT }),
							],
							{ concurrency: "unbounded" },
						);
						return { chat, mainThread, firstPage };
					}).pipe(asSessionUser, asHttpError(chatErrors)),
				)
				.handle("messages", ({ params, query }) =>
					view.messages(params.chatId, query).pipe(asSessionUser, asHttpError(chatErrors)),
				)
				.handle("history", ({ params, query }) =>
					view.history(params.chatId, query).pipe(asSessionUser, asHttpError(chatErrors)),
				)
				.handle("markRead", ({ params }) =>
					chats.markRead(params.chatId).pipe(asSessionUser, asHttpError(chatErrors)),
				)
				.handle("send", ({ params, payload }) =>
					chats
						.post({ chatId: params.chatId, messageId: payload.id, content: payload.message })
						.pipe(asSessionUser, asHttpError(chatErrors)),
				)
		);
	}),
);

const chatErrors = {
	...refusals,
	ChatPlacementRejected: BadRequest,
	MessageIdConflict: Conflict,
	ChatAgentHasNoModel: Conflict,
	InvalidChatCursor: BadRequest,
	InvalidThreadHistoryCursor: BadRequest,
};

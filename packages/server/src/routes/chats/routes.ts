import { MAX_ATTACHMENT_BYTES } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, PayloadTooLarge } from "@sugabots/contracts/http";
import { ChatDetailsView } from "@sugabots/core/chats/chat-details-view";
import { ChatFiles } from "@sugabots/core/chats/chats/chat-files";
import { ChatView } from "@sugabots/core/chats/chats/chat-view";
import { Chats } from "@sugabots/core/chats/chats/chats";
import { Reactions } from "@sugabots/core/chats/reactions/reactions";
import { ChatFileStore } from "@sugabots/core/files/chat-file-store";
import { userText } from "@sugabots/errors";
import { Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { fileResponse } from "./file-response.ts";

export const chatRoutes = HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		const view = yield* ChatView.Service;
		const files = yield* ChatFiles.Service;
		const details = yield* ChatDetailsView.Service;
		const reactions = yield* Reactions.Service;
		return handlers
			.handle("projectChats", ({ params }) =>
				view.chats(params.projectId).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("attention", ({ params }) =>
				view.attention(params.workspace).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("attentionMarks", ({ params }) =>
				view.attentionMarks(params.workspace).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("approvals", ({ params }) =>
				view.approvals(params.workspace).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("startProjectChat", ({ params, payload }) =>
				chats
					.startProjectChat({
						projectId: params.projectId,
						messageId: payload.id,
						content: payload.message,
					})
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("startInterview", ({ params }) =>
				chats.startInterview(params.botId).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("openAutomationFeed", ({ params }) =>
				chats
					.openAutomationFeed({ workspace: params.workspace, automationId: params.automationId })
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("renameChat", ({ params, payload }) =>
				chats
					.renameChat({ chatId: params.chatId, name: payload.name })
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("markResolved", ({ params }) =>
				chats
					.setResolved({ chatId: params.chatId, resolved: true })
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("reopen", ({ params }) =>
				chats
					.setResolved({ chatId: params.chatId, resolved: false })
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("messages", ({ params, query }) =>
				view.messages(params.chatId, query).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("history", ({ params, query }) =>
				view.history(params.chatId, query).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("markRead", ({ params }) =>
				chats.markRead(params.chatId).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("markNestedChatRead", ({ params }) =>
				chats.markNestedChatRead(params.chatId).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("send", ({ params, payload }) =>
				chats
					.post({
						chatId: params.chatId,
						messageId: payload.id,
						content: payload.message,
						attachments: payload.attachments,
						replyTo: payload.replyTo,
					})
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handleRaw("uploadFile", ({ params, query, request }) =>
				// Raw, so the file streams into the blob store rather than being read
				// into memory first.
				Effect.gen(function* () {
					// Refused before any of it is read, when it says how large it is.
					if (Number(request.headers["content-length"]) > MAX_ATTACHMENT_BYTES) {
						return yield* new ChatFileStore.FileTooLarge({ maxSize: MAX_ATTACHMENT_BYTES });
					}
					return yield* files.upload({
						chatId: params.chatId,
						name: query.name,
						type: query.type,
						stream: request.stream.pipe(
							Stream.mapError(
								() => new BadRequest({ message: userText`The upload was interrupted` }),
							),
						),
					});
				}).pipe(Effect.catchTags(storeOutagesAsDefects), asSignedInPerson, asHttpError(fileErrors)),
			)
			.handle("removeFile", ({ params }) =>
				files
					.removeUpload({ chatId: params.chatId, fileId: params.fileId })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("file", ({ params }) =>
				files
					.read({ chatId: params.chatId, fileId: params.fileId })
					.pipe(
						Effect.map(fileResponse),
						Effect.catchTags(storeOutagesAsDefects),
						asSignedInPerson,
						asHttpError(fileErrors),
					),
			)
			.handle("get", ({ params, query, request }) =>
				details
					.get(params.chatId, request.method === "HEAD" ? { ...query, limit: 1 } : query)
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("context", ({ params }) =>
				details.context(params.chatId).pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("react", ({ params }) =>
				reactions
					.add(params.messageId, params.emoji)
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			)
			.handle("unreact", ({ params }) =>
				reactions
					.remove(params.messageId, params.emoji)
					.pipe(asSignedInPerson, asHttpError(chatErrors)),
			);
	}),
);

/**
 * A blob store that cannot be reached, or refuses, is the server's
 * fault, not the caller's: logged, and answered as a server error.
 */
const storeOutagesAsDefects = {
	BlobStoreUnavailable: Effect.die,
	BlobStoreRejected: Effect.die,
} as const;

const chatErrors = {
	...refusals,
	HostUnavailable: BadRequest,
	MessageIdConflict: Conflict,
	ReplyTargetNotFound: BadRequest,
	BotHasNoModel: Conflict,
	InvalidPageCursor: BadRequest,
	UploadsNotFound: BadRequest,
	InvalidChatHistoryCursor: BadRequest,
	MessageNotFinished: Conflict,
	TooManyReactionEmoji: Conflict,
};

const fileErrors = {
	...refusals,
	FileTooLarge: PayloadTooLarge,
	TooManyUnsentUploads: Conflict,
	ChatFileNotFound: NotFound,
};

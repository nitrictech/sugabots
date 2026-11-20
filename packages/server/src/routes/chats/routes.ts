import { MAX_ATTACHMENT_BYTES } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, PayloadTooLarge } from "@sugabots/contracts/http";
import { ChatFiles } from "@sugabots/core/conversations/chats/chat-files";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { ConversationFiles } from "@sugabots/core/files/conversation-files";
import { userText } from "@sugabots/errors";
import { Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { fileResponse } from "./file-response.ts";

export const chatRoutes = HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		const view = yield* ChatView.Service;
		const files = yield* ChatFiles.Service;
		return handlers
			.handle("threads", ({ params }) =>
				view.threads(params.projectId).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("attention", ({ params }) =>
				view.attention(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("projectMarkers", ({ params }) =>
				view.projectMarkers(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("inbox", ({ params }) =>
				view.inbox(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("approvals", ({ params }) =>
				view.approvals(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("startProjectThread", ({ params, payload }) =>
				chats
					.startProjectThread({
						projectId: params.projectId,
						messageId: payload.id,
						content: payload.message,
					})
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("startInterview", ({ params }) =>
				chats.startInterview(params.botId).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("openAutomationFeed", ({ params }) =>
				chats
					.openAutomationFeed({ workspace: params.workspace, automationId: params.automationId })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("renameThread", ({ params, payload }) =>
				chats
					.changeThread({ conversationId: params.conversationId, change: { name: payload.name } })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("archiveThread", ({ params }) =>
				chats
					.changeThread({ conversationId: params.conversationId, change: { archived: true } })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("markDone", ({ params }) =>
				chats
					.setDone({ conversationId: params.conversationId, done: true })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("reopen", ({ params }) =>
				chats
					.setDone({ conversationId: params.conversationId, done: false })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("messages", ({ params, query }) =>
				view.messages(params.conversationId, query).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("history", ({ params, query }) =>
				view.history(params.conversationId, query).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("markRead", ({ params }) =>
				chats.markRead(params.conversationId).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("markAllRead", ({ params }) =>
				chats.markAllRead(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("markItemRead", ({ params }) =>
				chats.markItemRead(params.conversationId).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("send", ({ params, payload }) =>
				chats
					.post({
						conversationId: params.conversationId,
						messageId: payload.id,
						content: payload.message,
						attachments: payload.attachments,
						replyTo: payload.replyTo,
					})
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handleRaw("uploadFile", ({ params, query, request }) =>
				// Raw, so the file streams into the blob store rather than being read
				// into memory first.
				Effect.gen(function* () {
					// Refused before any of it is read, when it says how large it is.
					if (Number(request.headers["content-length"]) > MAX_ATTACHMENT_BYTES) {
						return yield* new ConversationFiles.FileTooLarge({ maxSize: MAX_ATTACHMENT_BYTES });
					}
					return yield* files.upload({
						conversationId: params.conversationId,
						name: query.name,
						type: query.type,
						stream: request.stream.pipe(
							Stream.mapError(
								() => new BadRequest({ message: userText`The upload was interrupted` }),
							),
						),
					});
				}).pipe(Effect.catchTags(storeOutagesAsDefects), asSessionUser, asHttpError(fileErrors)),
			)
			.handle("removeFile", ({ params }) =>
				files
					.removeUpload({ conversationId: params.conversationId, fileId: params.fileId })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("file", ({ params }) =>
				files
					.read({ conversationId: params.conversationId, fileId: params.fileId })
					.pipe(
						Effect.map(fileResponse),
						Effect.catchTags(storeOutagesAsDefects),
						asSessionUser,
						asHttpError(fileErrors),
					),
			);
	}),
);

/**
 * A blob store that cannot be reached, or refuses, is the installation's
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
	ChatArchived: Conflict,
	InvalidPageCursor: BadRequest,
	UploadsNotFound: BadRequest,
};

const fileErrors = {
	...refusals,
	FileTooLarge: PayloadTooLarge,
	TooManyUnsentUploads: Conflict,
	ConversationFileNotFound: NotFound,
};

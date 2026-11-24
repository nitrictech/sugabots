import { MAX_ATTACHMENT_BYTES } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, PayloadTooLarge } from "@sugabots/contracts/http";
import { ChatFiles } from "@sugabots/core/conversations/chats/chat-files";
import { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import { Chats } from "@sugabots/core/conversations/chats/chats";
import { ThreadFiles } from "@sugabots/core/conversations/thread-files/thread-files";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals, storeOutagesAsDefects } from "../../http/errors.ts";
import { fileResponse } from "../../http/file-response.ts";
import { uploadedBody } from "../../http/uploads.ts";

export const chatRoutes = HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
	Effect.gen(function* () {
		const chats = yield* Chats.Service;
		const view = yield* ChatView.Service;
		const files = yield* ChatFiles.Service;
		return handlers
			.handle("list", ({ params, query }) =>
				view
					.list({ workspace: params.workspace, pod: query.pod })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("podMarkers", ({ params }) =>
				view.podMarkers(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("activity", ({ params }) =>
				view.activity(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("approvals", ({ params }) =>
				view.approvals(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("openBotChannel", ({ params, payload }) =>
				chats
					.openBotChannel({ ...payload, workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("directMessages", ({ params }) =>
				view.directMessages(params.workspace).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("sendDirectMessage", ({ params, payload }) =>
				chats
					.sendDirectMessage({
						workspace: params.workspace,
						userIds: payload.userIds,
						messageId: payload.id,
						content: payload.message,
					})
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("directMessage", ({ params }) =>
				view.directMessage(params.conversationId).pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("openRoutineFeed", ({ params }) =>
				chats
					.openRoutineFeed({ workspace: params.workspace, routineId: params.routineId })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("openPodChat", ({ params }) =>
				chats
					.openPodChat({ workspace: params.workspace, podId: params.podId })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("startChat", ({ params, payload }) =>
				chats
					.startChat({ podId: params.podId, name: payload.name })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("renameChat", ({ params, payload }) =>
				chats
					.changeChat({ conversationId: params.conversationId, change: { name: payload.name } })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("archiveChat", ({ params }) =>
				chats
					.changeChat({ conversationId: params.conversationId, change: { archived: true } })
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("startThread", ({ params, payload }) =>
				chats
					.startThread({
						conversationId: params.conversationId,
						messageId: payload.id,
						content: payload.message,
						attachments: payload.attachments,
						replyTo: payload.replyTo,
						hostAgentId: payload.hostAgentId,
					})
					.pipe(asSessionUser, asHttpError(chatErrors)),
			)
			.handle("threadFrom", ({ params }) =>
				chats.threadFrom(params.messageId).pipe(asSessionUser, asHttpError(chatErrors)),
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
			.handle("markItemRead", ({ params }) =>
				chats.markItemRead(params.threadId).pipe(asSessionUser, asHttpError(chatErrors)),
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
					const stream = yield* uploadedBody(
						request,
						MAX_ATTACHMENT_BYTES,
						() => new ThreadFiles.FileTooLarge({ maxSize: MAX_ATTACHMENT_BYTES }),
					);
					return yield* files.upload({
						conversationId: params.conversationId,
						name: query.name,
						type: query.type,
						stream,
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

const chatErrors = {
	...refusals,
	HostNotCrew: BadRequest,
	DirectToSelf: BadRequest,
	TooManyInDirect: BadRequest,
	MessageIdConflict: Conflict,
	ReplyTargetNotFound: BadRequest,
	HostHasNoModel: Conflict,
	ChatArchived: Conflict,
	FirstChatNotArchivable: Conflict,
	InvalidPageCursor: BadRequest,
	UploadsNotFound: BadRequest,
};

const fileErrors = {
	...refusals,
	ThreadFileTooLarge: PayloadTooLarge,
	TooManyUnsentUploads: Conflict,
	ThreadFileNotFound: NotFound,
};

import { MAX_ATTACHMENT_BYTES } from "@sugabots/contracts";
import { FileTooLarge, UploadInterrupted } from "@sugabots/contracts/errors/chats";
import { BadRequest, Conflict, NotFound, PayloadTooLarge } from "@sugabots/contracts/http";
import { Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { fileResponse } from "./file-response.ts";

/** Chats, their messages, reactions and files, each endpoint its operation. */
export const chatRoutes = HttpApiBuilder.group(ServerApi, "chats", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("projectChats", ({ params }) =>
				callOperation("chats.projectChats", { projectId: params.projectId }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("attention", ({ params }) =>
				callOperation("chats.attention", { workspace: params.workspace }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("attentionMarks", ({ params }) =>
				callOperation("chats.attentionMarks", { workspace: params.workspace }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("approvals", ({ params }) =>
				callOperation("chats.approvals", { workspace: params.workspace }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("startProjectChat", ({ params, payload }) =>
				callOperation("chats.startProjectChat", {
					projectId: params.projectId,
					retryKey: payload.retryKey,
					message: payload.message,
				}).pipe(asHttpError(chatErrors)),
			)
			.handle("startInterview", ({ params }) =>
				callOperation("chats.startInterview", { botId: params.botId }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("openAutomationFeed", ({ params }) =>
				callOperation("chats.openAutomationFeed", {
					workspace: params.workspace,
					automationId: params.automationId,
				}).pipe(asHttpError(chatErrors)),
			)
			.handle("renameChat", ({ params, payload }) =>
				callOperation("chats.renameChat", { chatId: params.chatId, name: payload.name }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("markResolved", ({ params }) =>
				callOperation("chats.setResolved", { chatId: params.chatId, resolved: true }).pipe(
					Effect.catchTags(botResolutionRefusals),
					asHttpError(chatErrors),
				),
			)
			.handle("reopen", ({ params }) =>
				callOperation("chats.setResolved", { chatId: params.chatId, resolved: false }).pipe(
					Effect.catchTags(botResolutionRefusals),
					asHttpError(chatErrors),
				),
			)
			.handle("interruptTurn", ({ params }) =>
				callOperation("chats.interruptTurn", {
					chatId: params.chatId,
					turnId: params.turnId,
				}).pipe(asHttpError(chatErrors)),
			)
			.handle("messages", ({ params, query }) =>
				callOperation("chats.messages", { chatId: params.chatId, ...query }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("history", ({ params, query }) =>
				callOperation("chats.history", { chatId: params.chatId, ...query }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("markRead", ({ params }) =>
				callOperation("chats.markRead", { chatId: params.chatId }).pipe(asHttpError(chatErrors)),
			)
			.handle("markNestedChatRead", ({ params }) =>
				callOperation("chats.markNestedChatRead", { chatId: params.chatId }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("send", ({ params, payload }) =>
				callOperation("chats.send", { chatId: params.chatId, ...payload }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handleRaw("uploadFile", ({ params, query, request }) =>
				// Raw, so the file streams into the blob store rather than being read
				// into memory first.
				Effect.gen(function* () {
					// Refused before any of it is read, when it says how large it is.
					if (Number(request.headers["content-length"]) > MAX_ATTACHMENT_BYTES) {
						return yield* new FileTooLarge({ maxSize: MAX_ATTACHMENT_BYTES });
					}
					return yield* callOperation("chats.uploadFile", {
						chatId: params.chatId,
						...query,
						content: request.stream.pipe(Stream.mapError(() => new UploadInterrupted())),
					});
				}).pipe(asHttpError(fileErrors)),
			)
			.handle("removeFile", ({ params }) =>
				callOperation("chats.removeFile", { chatId: params.chatId, fileId: params.fileId }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("file", ({ params }) =>
				callOperation("chats.file", { chatId: params.chatId, fileId: params.fileId }).pipe(
					Effect.map(fileResponse),
					asHttpError(fileErrors),
				),
			)
			.handle("get", ({ params, query }) =>
				callOperation("chats.get", { chatId: params.chatId, ...query }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("context", ({ params }) =>
				callOperation("chats.context", { chatId: params.chatId }).pipe(asHttpError(chatErrors)),
			)
			.handle("react", ({ params }) =>
				callOperation("chats.react", { messageId: params.messageId, emoji: params.emoji }).pipe(
					asHttpError(chatErrors),
				),
			)
			.handle("unreact", ({ params }) =>
				callOperation("chats.unreact", { messageId: params.messageId, emoji: params.emoji }).pipe(
					asHttpError(chatErrors),
				),
			),
	),
);

/** What each way a chats operation can fail means over HTTP. */
const chatErrors = {
	...refusals,
	MessageRetryKeyConflict: Conflict,
	ReplyTargetNotFound: BadRequest,
	BotHasNoModel: Conflict,
	InvalidCursor: BadRequest,
	UnsentAttachmentsNotFound: BadRequest,
	MessageNotFinished: Conflict,
	TooManyReactionEmoji: Conflict,
};

/** What each way uploading or reading a chat's file can fail means over HTTP. */
const fileErrors = {
	...refusals,
	FileTooLarge: PayloadTooLarge,
	TooManyUnsentAttachments: Conflict,
	UploadInterrupted: BadRequest,
	ChatFileNotFound: NotFound,
};

const botResolutionRefusals = {
	ApprovalNeeded: Effect.die,
	ApprovalRefused: Effect.die,
	TurnEnded: Effect.die,
	TurnExecutionSuperseded: Effect.die,
};

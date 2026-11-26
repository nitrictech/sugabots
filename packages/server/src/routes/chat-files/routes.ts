import { MAX_ATTACHMENT_BYTES } from "@sugabots/contracts";
import { FileTooLarge, UploadInterrupted } from "@sugabots/contracts/errors/chats";
import { Effect, Stream } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { answerAsHttp } from "../../http/errors.ts";
import { fileResponse } from "./file-response.ts";

/**
 * Uploading a chat's file and reading one, each its operation. `ChatFilesApi`
 * says why they are written by hand: the bytes are the body, not JSON.
 */
export const chatFileRoutes = HttpApiBuilder.group(ServerApi, "chatFiles", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
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
				}).pipe(answerAsHttp),
			)
			.handle("file", ({ params }) =>
				callOperation("chats.file", { chatId: params.chatId, fileId: params.fileId }).pipe(
					Effect.map(fileResponse),
					answerAsHttp,
				),
			),
	),
);

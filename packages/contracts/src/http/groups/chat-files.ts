import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { uploadAttachmentQuerySchema, uploadedAttachmentSchema } from "../../attachments.ts";
import { uuidOrStringSchema } from "../../uuid.ts";
import { BadRequest, Conflict, Forbidden, NotFound, PayloadTooLarge } from "../errors.ts";
import { Session } from "../middleware.ts";
import { ServedOperation } from "../served.ts";

/**
 * A chat's files as bytes: uploading one to attach to a message, and reading
 * one attached to a message. Written by hand, because the bytes are the
 * request's body or the response's, not JSON.
 */
export class ChatFilesApi extends HttpApiGroup.make("chatFiles")
	.add(
		/**
		 * Uploads a file to attach to a message the caller then sends. The body
		 * is the file's bytes, and `Content-Type` its media type.
		 */
		HttpApiEndpoint.post("uploadFile", "/chats/:chatId/files", {
			params: { chatId: uuidOrStringSchema },
			query: uploadAttachmentQuerySchema,
			payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
			success: uploadedAttachmentSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, PayloadTooLarge, Conflict, NotFound, Forbidden],
		}).annotate(ServedOperation, "chats.uploadFile"),
		/** A file attached to a message in the chat, with its own media type. */
		HttpApiEndpoint.get("file", "/chats/:chatId/files/:fileId", {
			params: { chatId: uuidOrStringSchema, fileId: uuidOrStringSchema },
			success: HttpApiSchema.StreamUint8Array(),
			error: [NotFound, Forbidden],
		}).annotate(ServedOperation, "chats.file"),
	)
	.middleware(Session) {}

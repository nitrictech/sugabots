import { Schema } from "effect";
import { uuidSchema } from "./uuid.ts";

/** The largest file a person can attach to a message, in bytes. */
export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

/** The most files one message can carry, and so the most a person can have uploaded and not yet sent. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

const MAX_ATTACHMENT_NAME_CHARACTERS = 255;

/** A file's name as the person's computer had it, shown beside it and offered when it is downloaded. */
export const attachmentNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_ATTACHMENT_NAME_CHARACTERS),
	// Control characters would break the name out of a download's header.
	Schema.isPattern(/^[^\p{Cc}]*$/u),
);

/**
 * A media type such as `image/png` or `text/plain; charset=utf-8`, served
 * back as the file's `Content-Type`, so nothing in it can break out of that
 * header.
 */
export const mediaTypeSchema = Schema.Trim.check(
	Schema.isMaxLength(255),
	Schema.isPattern(/^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=("[^"\r\n]*"|[\w.+-]+))*$/),
);

export const uploadAttachmentQuerySchema = Schema.Struct({
	name: attachmentNameSchema,
	/** The file's media type, when the uploader knows it; otherwise it is taken from the name. */
	type: Schema.optional(mediaTypeSchema),
});

/** A file uploaded to a chat, ready to attach to a message. */
export const uploadedAttachmentSchema = Schema.Struct({
	id: uuidSchema,
	name: attachmentNameSchema,
	contentType: mediaTypeSchema,
	/** In bytes. */
	size: Schema.Int,
});

export type UploadedAttachment = typeof uploadedAttachmentSchema.Type;

import { Schema } from "effect";
import type { BuiltInToolKey } from "./built-in-tools.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

const MAX_FILE_TITLE_CHARACTERS = 200;
export const MAX_FILE_CONTENT_CHARACTERS = 500_000;

/**
 * What a file a bot writes holds, which decides how it is shown:
 * `markdown` is drawn as text; an `html` page runs in an isolated frame.
 */
export const writtenFileKindSchema = Schema.Literals(["markdown", "html"]);
export type WrittenFileKind = typeof writtenFileKindSchema.Type;

export const fileTitleSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_FILE_TITLE_CHARACTERS),
);

export const fileContentSchema = Schema.String.check(
	Schema.isMaxLength(MAX_FILE_CONTENT_CHARACTERS),
);

/** Who wrote a version: a bot, or nobody known any more. */
const fileAuthorSchema = Schema.NullOr(Schema.Struct({ botId: uuidSchema, name: Schema.String }));
export type FileAuthor = typeof fileAuthorSchema.Type;

/** A file a bot wrote with its file tools, kept in versions. */
const listedWrittenFileSchema = Schema.Struct({
	id: uuidSchema,
	/** The chat it was made in. */
	chatId: uuidSchema,
	kind: writtenFileKindSchema,
	title: Schema.String,
	/** The number of the current version, counting from 1. */
	version: Schema.Int.check(Schema.isGreaterThan(0)),
	createdBy: fileAuthorSchema,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});
export type ListedWrittenFile = typeof listedWrittenFileSchema.Type;

/**
 * A file on a message: an `attachment` a member sent, or a `bot_attachment`
 * a bot attached to its reply. Its bytes are served at the chat's file address.
 */
const listedMessageFileSchema = Schema.Struct({
	id: uuidSchema,
	/** The chat it was sent in. */
	chatId: uuidSchema,
	kind: Schema.Literals(["attachment", "bot_attachment"]),
	name: Schema.String,
	contentType: Schema.String,
	/** In bytes. */
	size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** The member who sent it, or the bot that attached it, by name; `null` once they are gone. */
	author: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
	/** When it was sent, which never changes after. */
	updatedAt: isoTimestampSchema,
});
export type ListedMessageFile = typeof listedMessageFileSchema.Type;

/** A file in a project's or a bot's Files: one a bot wrote, or one sent on a message. */
export const listedFileSchema = Schema.Union([listedWrittenFileSchema, listedMessageFileSchema]);
export type ListedFile = typeof listedFileSchema.Type;

export function isMessageFile(file: ListedFile): file is ListedMessageFile {
	return file.kind === "attachment" || file.kind === "bot_attachment";
}

export const listedFileVersionSchema = Schema.Struct({
	number: Schema.Int.check(Schema.isGreaterThan(0)),
	author: fileAuthorSchema,
	createdAt: isoTimestampSchema,
});
export type ListedFileVersion = typeof listedFileVersionSchema.Type;

/** A written file as of one version, with that version's content. */
export const writtenFileSchema = Schema.Struct({
	...listedWrittenFileSchema.fields,
	content: Schema.String,
	shownVersion: listedFileVersionSchema,
});
export type WrittenFile = typeof writtenFileSchema.Type;

/** The tools whose completed calls write a file, returning what `fileWrittenSchema` reads. */
export const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set([
	"file_write",
	"file_edit",
] satisfies BuiltInToolKey[]);

/**
 * What a call to one of `FILE_WRITING_TOOLS` returns when it writes: the
 * file, at the version it wrote. The model is told this, and it is recorded
 * as the call's output.
 */
export const fileWrittenSchema = Schema.Struct({
	status: Schema.Literal("written"),
	fileId: uuidSchema,
	kind: writtenFileKindSchema,
	title: Schema.String,
	version: Schema.Int.check(Schema.isGreaterThan(0)),
});

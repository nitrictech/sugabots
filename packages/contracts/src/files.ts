import { Schema } from "effect";
import type { BuiltInToolKey } from "./built-in-tools.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

const MAX_FILE_TITLE_CHARACTERS = 200;
export const MAX_FILE_CONTENT_CHARACTERS = 500_000;

/**
 * What a file a bot writes holds, which decides how it is shown: a
 * `document` is markdown, drawn as text; an `html` page runs in an isolated
 * frame.
 */
export const writtenFileKindSchema = Schema.Literals(["document", "html"]);
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
const writtenFileSummarySchema = Schema.Struct({
	id: uuidSchema,
	/** The conversation it was made in. */
	conversationId: uuidSchema,
	kind: writtenFileKindSchema,
	title: Schema.String,
	/** The number of the current version, counting from 1. */
	version: Schema.Int.check(Schema.isGreaterThan(0)),
	createdBy: fileAuthorSchema,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});
export type WrittenFileSummary = typeof writtenFileSummarySchema.Type;

/**
 * A file on a message: one a person uploaded and sent, or one a bot attached
 * to its reply. Its bytes are served at the conversation's file address.
 */
const messageFileSummarySchema = Schema.Struct({
	id: uuidSchema,
	/** The conversation it was sent in. */
	conversationId: uuidSchema,
	kind: Schema.Literals(["upload", "attachment"]),
	name: Schema.String,
	contentType: Schema.String,
	/** In bytes. */
	size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Who uploaded it, or the bot that attached it; `null` once they are gone. */
	sentBy: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
	/** When it was sent, which never changes after. */
	updatedAt: isoTimestampSchema,
});
export type MessageFileSummary = typeof messageFileSummarySchema.Type;

/** A file in a project's or a bot's Files: one a bot wrote, or one sent on a message. */
export const fileSummarySchema = Schema.Union([writtenFileSummarySchema, messageFileSummarySchema]);
export type FileSummary = typeof fileSummarySchema.Type;

export function isMessageFile(file: FileSummary): file is MessageFileSummary {
	return file.kind === "upload" || file.kind === "attachment";
}

export const fileVersionSummarySchema = Schema.Struct({
	number: Schema.Int.check(Schema.isGreaterThan(0)),
	author: fileAuthorSchema,
	createdAt: isoTimestampSchema,
});
export type FileVersionSummary = typeof fileVersionSummarySchema.Type;

/** A written file as of one version, with that version's content. */
export const writtenFileSchema = Schema.Struct({
	...writtenFileSummarySchema.fields,
	content: Schema.String,
	shownVersion: fileVersionSummarySchema,
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

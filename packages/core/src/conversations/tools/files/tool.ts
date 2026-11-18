import {
	type BuiltInToolKey,
	FILE_WRITING_TOOLS,
	fileContentSchema,
	fileTitleSchema,
	fileWrittenSchema,
	MAX_FILE_CONTENT_CHARACTERS,
	type WrittenFile,
	type WrittenFileSummary,
	writtenFileKindSchema,
} from "@sugabots/contracts";
import { type Tool, tool } from "ai";
import { Effect, Option, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { Files } from "../../../files/files.ts";
import { isUuid } from "../../../ids/ids.ts";
import { noInputSchema } from "../no-input.ts";
import { READ_CONVERSATION_FILE_TOOL } from "../read-conversation-file/tool.ts";

const FILE_LIST_TOOL = "file_list" satisfies BuiltInToolKey;
export const FILE_READ_TOOL = "file_read" satisfies BuiltInToolKey;
export const FILE_WRITE_TOOL = "file_write" satisfies BuiltInToolKey;
export const FILE_EDIT_TOOL = "file_edit" satisfies BuiltInToolKey;

export const FILE_TOOLS: ReadonlySet<string> = new Set([
	FILE_LIST_TOOL,
	FILE_READ_TOOL,
	FILE_WRITE_TOOL,
	FILE_EDIT_TOOL,
]);

interface FileToolOptions {
	by: Files.BotInConversation;
	/** The turn the tools are bound to, whose writes to one file are one version. */
	turnId: string;
	/** The turn's recorded calls: what its completed calls to some tools returned. */
	calls: {
		completedOutputs: (
			turnId: string,
			tools: readonly string[],
		) => Effect.Effect<readonly unknown[]>;
	};
	authoring: Files.AuthoringInterface;
	run: RunEffect;
}

/** What the model is told about a file it made or changed. */
type Written = typeof fileWrittenSchema.Type;

type Refusal = { status: "refused"; reason: string };

const fileIdSchema = Schema.String.check(Schema.isUUID()).annotate({
	description: "The file's id, from file_list or the write that made it",
});
const baseVersionSchema = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	description:
		"The version your change is based on, from file_read or your last write. A change based on an older version is refused.",
});

/**
 * The tools a bot uses to keep documents and HTML pages as files, bound
 * to one turn. Refusals come back as results the model can act on: a stale
 * version tells it to read again, and an edit whose text isn't there once says so.
 *
 * A reply's writes to one file are one version: a change based on a
 * version this turn wrote is written over it, so a reply that edits a page
 * five times leaves one version, not five. Which versions the turn wrote is
 * read from its recorded calls, which outlast a retried or resumed turn.
 */
export function fileTools({
	by,
	turnId,
	calls,
	authoring,
	run,
}: FileToolOptions): Record<string, Tool> {
	const written = (file: WrittenFile): Written => ({
		status: "written",
		fileId: file.id,
		kind: file.kind,
		title: file.title,
		version: file.version,
	});

	/** Whether this turn wrote `version` of the file, and so may write over it. */
	const wroteInTurn = (fileId: string, version: number) =>
		Effect.map(calls.completedOutputs(turnId, [...FILE_WRITING_TOOLS]), (outputs) =>
			outputs.some((output) => {
				const written = Schema.decodeUnknownOption(fileWrittenSchema)(output);
				return (
					Option.isSome(written) &&
					written.value.fileId === fileId &&
					written.value.version === version
				);
			}),
		);

	const refusingChanges = <E extends AuthoringFailure>(
		change: Effect.Effect<WrittenFile, E>,
	): Promise<Written | Refusal> =>
		run(
			change.pipe(
				Effect.map(written),
				Effect.catch((failure) => Effect.succeed(refusalFor(failure))),
			),
		);

	return {
		[FILE_LIST_TOOL]: tool({
			description:
				"List the documents and pages you can read, newest first: those you wrote, and those written in the channel you are in.",
			inputSchema: noInputSchema,
			execute: async (): Promise<{ files: FileListing[] }> => ({
				files: (await run(authoring.list(by))).map(listing),
			}),
		}),

		[FILE_READ_TOOL]: tool({
			description: `Read the current content and version of a document or page from ${FILE_LIST_TOOL}. A file on a message is read with ${READ_CONVERSATION_FILE_TOOL}.`,
			inputSchema: Schema.Struct({ fileId: fileIdSchema }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: ({ fileId }) =>
				run(
					authoring.read(by, fileId).pipe(
						Effect.map((file) => ({
							status: "found" as const,
							...listing(file),
							content: file.content,
						})),
						Effect.catchTag("FileNotFound", (failure) => Effect.succeed(refusalFor(failure))),
					),
				),
		}),

		[FILE_WRITE_TOOL]: tool({
			description: `Write a file, for work people will come back to: a plan, report, notes or a page. Without \`fileId\` it creates one, with \`kind\` and \`title\`. With \`fileId\` and \`baseVersion\` it replaces that file's whole content as a new version; pass them whenever you change a file that already exists, rather than making another, and use file_edit for a small change. ${KIND_RULES}`,
			inputSchema: Schema.Struct({
				fileId: Schema.optional(
					Schema.String.annotate({
						description:
							"Leave out or empty to create a new file. To change one, its id from file_list or the write that made it",
					}),
				),
				baseVersion: Schema.optional(
					Schema.Int.annotate({
						description:
							"Leave out when creating. When changing, the version your change is based on, from file_read or your last write; a change based on an older version is refused",
					}),
				),
				kind: Schema.optional(
					writtenFileKindSchema.annotate({ description: "Needed when creating; it never changes" }),
				),
				title: Schema.optional(fileTitleSchema),
				content: fileContentSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ fileId, baseVersion, kind, title, content }) => {
				// Some models fill every field, sending "" or "new" for a file
				// still to be made. Ids are UUIDs, so anything else names none.
				if (fileId === undefined || !isUuid(fileId)) {
					if (kind === undefined || title === undefined)
						return refused(WRITE_REFUSALS.newNeedsKindAndTitle);
					return refusingChanges(authoring.create(by, { kind, title, content }));
				}
				if (baseVersion === undefined) return refused(WRITE_REFUSALS.changeNeedsVersion);
				return refusingChanges(
					Effect.flatMap(wroteInTurn(fileId, baseVersion), (inPlace) =>
						authoring.replace(by, {
							fileId,
							baseVersion,
							content,
							inPlace,
							...(title ? { title } : {}),
							...(kind ? { kind } : {}),
						}),
					),
				);
			},
		}),

		[FILE_EDIT_TOOL]: tool({
			description:
				"Change part of a file, as a new version: `oldText` is replaced by `newText`. `oldText` must appear exactly once, so quote enough around the change to make it unique, exactly as it is in the content from file_read or your last write.",
			inputSchema: Schema.Struct({
				fileId: fileIdSchema,
				baseVersion: baseVersionSchema,
				oldText: Schema.String.check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_FILE_CONTENT_CHARACTERS),
				),
				newText: Schema.String.check(Schema.isMaxLength(MAX_FILE_CONTENT_CHARACTERS)),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: (input) =>
				refusingChanges(
					Effect.flatMap(wroteInTurn(input.fileId, input.baseVersion), (inPlace) =>
						authoring.edit(by, { ...input, inPlace }),
					),
				),
		}),
	};
}

type FileListing = Pick<WrittenFileSummary, "kind" | "title" | "version" | "updatedAt"> & {
	fileId: string;
};

const listing = (summary: WrittenFileSummary): FileListing => ({
	fileId: summary.id,
	kind: summary.kind,
	title: summary.title,
	version: summary.version,
	updatedAt: summary.updatedAt,
});

/** How each kind is written, for file_write to tell the model. */
const KIND_RULES =
	"A `document` is markdown with `#` headings. An `html` page is a complete HTML document, shown in the chat under your reply as well as on its own, so it suits charts, tables and small interactive tools. Make it responsive: it is shown in the chat, opened large beside it and on phones, from about 360px to 1200px wide, so use fluid widths with no fixed or maximum width of its own, let rows wrap or stack when narrow, and size charts and canvases to their container, redrawing when it resizes. It is drawn on the chat's own ground with the app's theme, so it looks part of the conversation: leave the page background transparent, add no outer card or border of your own, and colour it with the app's CSS variables, which follow light and dark mode: --foreground, --body-foreground, --muted-foreground, --subtle-foreground for text; --card, --panel, --chip, --hover for surfaces; --border, --border-strong; --primary, --link, --success-text, --destructive-text, --warning for accents; and --font-sans, --font-mono. It runs in an isolated frame with no network access except scripts from https://cdn.jsdelivr.net (such as Chart.js), so inline its CSS and embed its data.";

/** file_write's inputs that don't go together, and what to do instead. */
const WRITE_REFUSALS = {
	newNeedsKindAndTitle: "A new file needs a `kind` and a `title`.",
	changeNeedsVersion:
		"Changing a file needs the `baseVersion` you read or last wrote. Read it with file_read if you don't have it.",
} as const;

const refused = (reason: string): Refusal => ({ status: "refused", reason });

type AuthoringFailure =
	| Files.NotFound
	| Files.Stale
	| Files.KindFixed
	| Files.TooLarge
	| Files.EditTextUnmatched;

function refusalFor(failure: AuthoringFailure): Refusal {
	switch (failure._tag) {
		case "FileNotFound":
			return {
				status: "refused",
				reason: `There is no document or page with that id here. A file on a message is read with ${READ_CONVERSATION_FILE_TOOL}.`,
			};
		case "FileStale":
			return {
				status: "refused",
				reason: `The file is at version ${failure.currentVersion} now. Read it again and base your change on that.`,
			};
		case "FileKindFixed":
			return {
				status: "refused",
				reason: `That file is ${failure.kind === "html" ? "an `html` page" : `a \`${failure.kind}\``} and stays one. Leave out \`fileId\` to create a new file of another kind.`,
			};
		case "FileContentTooLarge":
			return {
				status: "refused",
				reason: `That would make the file over ${failure.maxCharacters.toLocaleString("en")} characters, the most it can hold. Make it shorter, or split it into more than one file.`,
			};
		case "EditTextUnmatched":
			return {
				status: "refused",
				reason:
					failure.matches === 0
						? "`oldText` isn't in the file. Read it again and quote its text exactly."
						: `\`oldText\` appears ${failure.matches} times. Quote more around the change so it appears once.`,
			};
	}
}

import { tool } from "ai";
import { Effect, Schema, Stream } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { ThreadFiles } from "../../thread-files/thread-files.ts";

export const READ_THREAD_FILE_TOOL = "read_thread_file";

/** Lines returned when the model asks for no particular number. */
const DEFAULT_LINES = 2_000;

/** Longer lines are cut, so one minified line cannot fill a whole read. */
const MAX_LINE_CHARACTERS = 2_000;

/**
 * Most characters of lines one call returns, as JSON escapes them. Below the
 * size at which a tool's result, measured as JSON, is kept as a file instead,
 * so a read is never itself turned into one.
 */
export const MAX_READ_CHARACTERS = 40_000;

const MAX_PATTERN_CHARACTERS = 500;

const NOT_FOUND = {
	refused: "There is no file with that id in this thread.",
} satisfies ReadThreadFileResult;

const UNAVAILABLE = {
	refused: "The file can't be read right now. Try again shortly.",
} satisfies ReadThreadFileResult;

const REJECTED = {
	refused: "Files can't be read in this installation.",
} satisfies ReadThreadFileResult;

export type ReadThreadFileResult =
	| {
			/** The lines read, each after its number and a tab. */
			lines: string;
			totalLines: number;
			/** Where to start the next call to read on, when there is more. */
			continueFrom?: number;
	  }
	| { refused: string };

/**
 * The `read_thread_file` tool: reads part of a file in this thread, such as a tool
 * result too large to have been given whole, by line or by searching it.
 * Offered on every turn, so the tools a thread sends never change for it.
 */
export function readThreadFileTool({
	threadId,
	files,
	run,
}: {
	threadId: string;
	files: Pick<ThreadFiles.Interface, "read">;
	run: RunEffect<never>;
}) {
	return tool({
		description: `Read a file in this thread, such as a tool result too large to have been given to you whole, which named its file and how to read on. Returns up to ${DEFAULT_LINES} lines from \`offset\`, each after its line number, with the file's total lines and, when there is more, the line to continue from. Give \`pattern\` to get only the lines containing it instead.`,
		inputSchema: Schema.Struct({
			file: Schema.String.annotate({ description: "The file's id." }),
			offset: Schema.optional(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
					description: "The line to start at, counting from 1. Defaults to the first.",
				}),
			),
			limit: Schema.optional(
				Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DEFAULT_LINES })).annotate({
					description: `The most lines to return. Defaults to ${DEFAULT_LINES}.`,
				}),
			),
			pattern: Schema.optional(
				Schema.String.check(
					Schema.isMinLength(1),
					Schema.isMaxLength(MAX_PATTERN_CHARACTERS),
				).annotate({
					description:
						"Return only lines containing this text, ignoring case, searching from `offset`.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ file, offset, limit, pattern }): Promise<ReadThreadFileResult> =>
			run(
				Effect.gen(function* () {
					const found = yield* files.read({ threadId, fileId: file });
					if (!isText(found.contentType)) {
						return {
							refused: `The file is ${found.contentType}, not text, so it has no lines to read.`,
						};
					}
					const text = yield* Stream.mkString(Stream.decodeText(found.stream));
					return readLines(text, { offset: offset ?? 1, limit: limit ?? DEFAULT_LINES, pattern });
				}).pipe(
					Effect.catchTags({
						ThreadFileNotFound: () => Effect.succeed(NOT_FOUND),
						BlobStoreUnavailable: () => Effect.succeed(UNAVAILABLE),
						BlobStoreRejected: (rejected) =>
							Effect.as(
								Effect.logError("The blob store rejected reading a file", rejected),
								REJECTED,
							),
					}),
				),
			),
	});
}

function isText(contentType: string): boolean {
	return contentType.startsWith("text/") || contentType.startsWith("application/json");
}

/**
 * Up to `limit` of `text`'s lines from `offset`, numbered, or only those
 * containing `pattern`, stopping short at `MAX_READ_CHARACTERS` of JSON.
 */
function readLines(
	text: string,
	{ offset, limit, pattern }: { offset: number; limit: number; pattern: string | undefined },
): ReadThreadFileResult {
	const lines = splitLines(text);
	if (offset > lines.length) {
		return { refused: `The file has ${lines.length} lines, so there is no line ${offset}.` };
	}
	const needle = pattern?.toLowerCase();
	const read: string[] = [];
	let characters = 0;
	for (let index = offset - 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (needle && !line.toLowerCase().includes(needle)) continue;
		const numbered = `${index + 1}\t${clip(line)}`;
		// Escaping can double a line of quotes or backslashes. The quotes
		// `JSON.stringify` adds count for the escaped newline that joins it.
		const escapedCharacters = JSON.stringify(numbered).length;
		const full = read.length === limit || characters + escapedCharacters > MAX_READ_CHARACTERS;
		if (full) {
			return { lines: read.join("\n"), totalLines: lines.length, continueFrom: index + 1 };
		}
		read.push(numbered);
		characters += escapedCharacters;
	}
	return { lines: read.join("\n"), totalLines: lines.length };
}

/** Lines as an editor numbers them: a final newline ends the last line rather than starting another. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r?\n/);
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function clip(line: string): string {
	return line.length <= MAX_LINE_CHARACTERS
		? line
		: `${line.slice(0, MAX_LINE_CHARACTERS)}… (${line.length - MAX_LINE_CHARACTERS} more characters)`;
}

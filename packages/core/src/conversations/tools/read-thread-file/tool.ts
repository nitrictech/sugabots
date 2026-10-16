import { mediaTypeEssence } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { tool } from "ai";
import { Effect, Option, Schema, Stream } from "effect";
import type { BlobStore } from "../../../blob-store/blob-store.ts";
import type { RunEffect } from "../../../database/database.ts";
import type { ThreadFiles } from "../../thread-files/thread-files.ts";
import {
	type Image,
	MAX_IMAGE_BYTES,
	SHOWN_IMAGE_FORMATS,
	shownImageType,
	withImages,
} from "../images.ts";

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

/**
 * What an agent is told when a file in its thread can't be read. A store that
 * refuses is set up wrong, which trying again won't fix, so that is logged.
 */
export function unreadableFileRefusal(
	failure: ThreadFiles.FileNotFound | BlobStore.Failure,
): Effect.Effect<UserText> {
	switch (failure._tag) {
		case "ThreadFileNotFound":
			return Effect.succeed(userText`There is no file with that id in this thread.`);
		case "BlobStoreUnavailable":
			return Effect.succeed(userText`The file can't be read right now. Try again shortly.`);
		case "BlobStoreRejected":
			return Effect.as(
				Effect.logError("The blob store rejected reading a file", failure),
				userText`Files can't be read in this installation.`,
			);
	}
}

export type ReadThreadFileResult =
	| {
			/** The lines read, each after its number and a tab. */
			lines: string;
			totalLines: number;
			/** Where to start the next call to read on, when there is more. */
			continueFrom?: number;
	  }
	| { text: string; images: Image[] }
	| { refused: string };

/**
 * The `read_thread_file` tool: reads part of a file in this thread, such as a
 * file a person attached or a tool result too large to have been given whole,
 * by line or by searching it, or shows an image to a model that takes them.
 * Offered on every turn, so the tools a thread sends change only when its
 * agent's model does.
 */
export function readThreadFileTool({
	threadId,
	files,
	acceptsImages,
	run,
}: {
	threadId: string;
	files: Pick<ThreadFiles.Interface, "read">;
	acceptsImages: boolean;
	run: RunEffect<never>;
}) {
	return tool({
		description: `Read a file in this thread: one a person attached, or a tool result too large to have been given to you whole, which named its file and how to read on. For a text file, returns up to ${DEFAULT_LINES} lines from \`offset\`, each after its line number, with the file's total lines and, when there is more, the line to continue from. Give \`pattern\` to get only the lines containing it instead.${acceptsImages ? ` A ${SHOWN_IMAGE_FORMATS} image is shown to you instead.` : ""}`,
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
					const notText = {
						refused: `The file is ${found.contentType}, not text, so it has no lines to read.`,
					};
					// The file's start says what it is, so one that is neither text nor
					// an image is refused without reading the rest of it.
					const start = Option.getOrElse(
						yield* Stream.runHead(found.stream),
						() => new Uint8Array(),
					);
					const wholeFile = Effect.flatMap(files.read({ threadId, fileId: file }), ({ stream }) =>
						collect(stream),
					);
					const imageType = shownImageType(start);
					if (imageType !== undefined) {
						if (!acceptsImages) {
							return { refused: "The file is an image, and you can't be shown images." };
						}
						if (found.size > MAX_IMAGE_BYTES) {
							return {
								refused: `The image is ${found.size} bytes, larger than the ${MAX_IMAGE_BYTES} that can be shown.`,
							};
						}
						return {
							text: `The image ${found.name ?? file}.`,
							images: [{ data: (yield* wholeFile).toString("base64"), mediaType: imageType }],
						};
					}
					if (declaredText(found.contentType)) {
						// As declared text, in whatever encoding, with what isn't UTF-8 replaced.
						const text = new TextDecoder().decode(yield* wholeFile);
						return readLines(text, { offset: offset ?? 1, limit: limit ?? DEFAULT_LINES, pattern });
					}
					if (!startsAsText(start)) return notText;
					const text = strictText(yield* wholeFile);
					if (text === undefined) return notText;
					return readLines(text, { offset: offset ?? 1, limit: limit ?? DEFAULT_LINES, pattern });
				}).pipe(
					Effect.catch((failure) =>
						Effect.map(unreadableFileRefusal(failure), (refused) => ({ refused })),
					),
				),
			),
		toModelOutput: ({ output }) => withImages(output, acceptsImages),
	});
}

/** Whether a file was given a text type: read as text, whatever its bytes. */
function declaredText(contentType: string): boolean {
	const essence = mediaTypeEssence(contentType);
	return essence.startsWith("text/") || essence === "application/json";
}

/**
 * Whether a file's first bytes read as text: UTF-8 without a NUL byte. Many
 * text files, such as source code, arrive with a type that says otherwise or
 * with none, so a file not declared text is judged by its bytes.
 */
function startsAsText(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return false;
	try {
		// Streaming, so a character cut off at the end of the chunk is not an error.
		new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/** `bytes` as UTF-8 text without a NUL byte, or undefined when they are not that. */
function strictText(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function collect<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<Buffer, E> {
	return Effect.map(Stream.runCollect(stream), (chunks) => Buffer.concat(chunks));
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
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r?\n/);
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function clip(line: string): string {
	return line.length <= MAX_LINE_CHARACTERS
		? line
		: `${line.slice(0, MAX_LINE_CHARACTERS)}… (${line.length - MAX_LINE_CHARACTERS} more characters)`;
}

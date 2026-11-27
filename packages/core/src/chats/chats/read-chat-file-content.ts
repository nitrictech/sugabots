import { mediaTypeEssence } from "@sugabots/contracts";
import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import { CHAT_FILE_READ_DEFAULT_LINES } from "@sugabots/contracts/operations/chat-reads";
import { Effect, Option, Stream } from "effect";
import type { BlobStore } from "../../blob-store/blob-store.ts";
import type { ChatFileStore } from "../../files/chat-file-store.ts";
import { MAX_IMAGE_BYTES, shownImageType } from "../tools/images.ts";
import { unreadableFileRefusal } from "../tools/unreadable-file.ts";

const MAX_LINE_CHARACTERS = 2_000;

export const MAX_READ_CHARACTERS = 40_000;

type ReadChatFileResult = OutputOf<"chats.readChatFile">;

export const readChatFileContent = <R>(
	open: Effect.Effect<ChatFileStore.StoredFile, ChatFileStore.FileNotFound | BlobStore.Failure>,
	{ offset, limit, pattern }: Omit<InputOf<"chats.readChatFile">, "file" | "chat">,
	acceptsImages: Effect.Effect<boolean, never, R>,
): Effect.Effect<ReadChatFileResult, ChatFileStore.FileNotFound, R> =>
	Effect.gen(function* () {
		const found = yield* open;
		const notText = {
			refused: `The file is ${found.contentType}, not text, so it has no lines to read.`,
		};
		// The file's start says what it is, so one that is neither text nor
		// an image is refused without reading the rest of it.
		const start = Option.getOrElse(yield* Stream.runHead(found.stream), () => new Uint8Array());
		const wholeFile = Effect.flatMap(open, ({ stream }) => collect(stream));
		const imageType = shownImageType(start);
		if (imageType !== undefined) {
			if (!(yield* acceptsImages)) {
				return { refused: "The file is an image, and you can't be shown images." };
			}
			if (found.size > MAX_IMAGE_BYTES) {
				return {
					refused: `The image is ${found.size} bytes, larger than the ${MAX_IMAGE_BYTES} that can be shown.`,
				};
			}
			return {
				text: `The image ${found.name ?? found.id}.`,
				images: [{ data: (yield* wholeFile).toString("base64"), mediaType: imageType }],
			};
		}
		if (declaredText(found.contentType)) {
			// As declared text, in whatever encoding, with what isn't UTF-8 replaced.
			const text = new TextDecoder().decode(yield* wholeFile);
			return readLines(text, {
				offset: offset ?? 1,
				limit: limit ?? CHAT_FILE_READ_DEFAULT_LINES,
				pattern,
			});
		}
		if (!startsAsText(start)) return notText;
		const text = strictText(yield* wholeFile);
		if (text === undefined) return notText;
		return readLines(text, {
			offset: offset ?? 1,
			limit: limit ?? CHAT_FILE_READ_DEFAULT_LINES,
			pattern,
		});
	}).pipe(
		Effect.catchTags({
			BlobStoreUnavailable: (error) =>
				Effect.map(unreadableFileRefusal(error), (refused) => ({ refused })),
			BlobStoreRejected: (error) =>
				Effect.map(unreadableFileRefusal(error), (refused) => ({ refused })),
		}),
	);

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
): ReadChatFileResult {
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

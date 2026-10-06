import { Effect, Stream } from "effect";
import type { ThreadFiles } from "../../thread-files/thread-files.ts";
import { READ_THREAD_FILE_TOOL, splitLines } from "../../tools/read-thread-file/tool.ts";

/**
 * Results longer than this, as JSON, are kept as a file and the model is given
 * their start. About 12,500 tokens: the other agents we compared cap at about
 * 50 KB, and a turn resends every result it has had at each step.
 */
export const MAX_RESULT_CHARACTERS = 50_000;

/** How much of a long result the model is given to decide whether to read on. */
const PREVIEW_CHARACTERS = 2_000;

/**
 * What the model is given in place of a result too long to give it whole: its
 * start, and the file it is kept as, unless the file could not be written.
 */
export type LongResult = {
	truncated: true;
	characters: number;
	preview: string;
	note: string;
} & ({ file: string; lines: number } | { file?: never });

/**
 * `output` as the model should get it: unchanged, or past
 * `MAX_RESULT_CHARACTERS` kept as a file in the thread, with its start and how
 * to read the rest with `read_thread_file`. Only its start when the blob store
 * can't keep it.
 */
export const forModel = (output: unknown, keeping: Keeping): Effect.Effect<unknown> => {
	// Images reach the model as image parts rather than as text, so the limit
	// is for the rest of the result.
	if (!hasImages(output)) {
		return longResultFor(output, keeping).pipe(Effect.map((long) => long ?? output));
	}
	const { images, ...rest } = output;
	return longResultFor(rest, keeping).pipe(
		Effect.map((long) => (long ? { ...long, images } : output)),
	);
};

/** Where a long result is kept: the thread, and the call whose result it is. */
interface Keeping {
	files: Pick<ThreadFiles.Interface, "write">;
	threadId: string;
	toolCallId: string;
}

/** A result with images for the model, such as a screenshot, which the tool's `toModelOutput` gives it as image parts. */
function hasImages(output: unknown): output is { images: unknown } & Record<string, unknown> {
	return typeof output === "object" && output !== null && "images" in output;
}

/** What the model is given in place of `output`, or `undefined` when `output` is short enough to give whole. */
const longResultFor = (
	output: unknown,
	{ files, threadId, toolCallId }: Keeping,
): Effect.Effect<LongResult | undefined> =>
	Effect.gen(function* () {
		const sent = JSON.stringify(output) ?? "";
		if (sent.length <= MAX_RESULT_CHARACTERS) return undefined;
		const { text, contentType } = readableText(output);
		const preview = text.slice(0, PREVIEW_CHARACTERS);
		const write = (kept: string) =>
			files.write({
				threadId,
				toolCallId,
				content: { stream: Stream.succeed(new TextEncoder().encode(kept)), contentType },
			});
		const stored = yield* write(text).pipe(
			Effect.map((file) => ({ file, kept: text, complete: true })),
			Effect.catchTag("ThreadFileTooLarge", ({ maxSize }) => {
				const kept = startWithin(text, maxSize);
				return write(kept).pipe(
					// `startWithin` keeps the file under the limit just reported.
					Effect.catchTag("ThreadFileTooLarge", Effect.die),
					Effect.map((file) => ({ file, kept, complete: false })),
				);
			}),
			Effect.catchTags({
				BlobStoreUnavailable: () => Effect.succeed(undefined),
				BlobStoreRejected: (rejected) =>
					Effect.as(
						Effect.logError("The blob store rejected keeping a tool result", rejected),
						undefined,
					),
			}),
		);
		if (!stored) {
			return {
				truncated: true,
				characters: sent.length,
				preview,
				note: `The result was ${sent.length} characters, too long to give you whole, and could not be kept to read on, so \`preview\` is only its start.`,
			} satisfies LongResult;
		}
		const { file, kept, complete } = stored;
		const lines = splitLines(kept).length;
		const keptAs = complete
			? `It is kept whole as file ${file.id}`
			: `Its first ${lines} lines are kept as file ${file.id}; the rest was too large to keep`;
		return {
			truncated: true,
			file: file.id,
			characters: sent.length,
			lines,
			preview,
			note: `The result was ${sent.length} characters, too long to give you whole. ${keptAs}, ${lines} lines, and \`preview\` is its start. Read on with ${READ_THREAD_FILE_TOOL}, by line or by searching it with a pattern, rather than calling the tool again.`,
		} satisfies LongResult;
	});

/**
 * The result as text with lines to page through. An MCP result's text parts
 * are taken out of the JSON that wraps them, and JSON, which servers often
 * send on a single line, is pretty-printed.
 */
function readableText(output: unknown): { text: string; contentType: string } {
	const texts = typeof output === "string" ? [output] : mcpTexts(output);
	if (texts) {
		const parts = texts.map(prettyIfJson);
		return {
			text: parts.map((part) => part.text).join("\n\n"),
			contentType: parts.length === 1 && parts[0]?.json ? JSON_TYPE : TEXT_TYPE,
		};
	}
	return { text: JSON.stringify(output, null, 2), contentType: JSON_TYPE };
}

const TEXT_TYPE = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";

/** The texts of an MCP tool result made only of text parts, or `undefined` for any other value. */
function mcpTexts(output: unknown): string[] | undefined {
	if (typeof output !== "object" || output === null || !("content" in output)) return undefined;
	const { content } = output;
	if (!Array.isArray(content)) return undefined;
	const texts = content.map((part: unknown) =>
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
			? part.text
			: undefined,
	);
	return texts.every((text) => text !== undefined) ? texts : undefined;
}

function prettyIfJson(text: string): { text: string; json: boolean } {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { text, json: false };
	try {
		return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
	} catch {
		return { text, json: false };
	}
}

/**
 * As much of `text`'s start as fits in `maxBytes`, ending at a line break when
 * there is one.
 */
function startWithin(text: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(text);
	// A cut inside a character decodes to U+FFFD, which can take more bytes than
	// the part it replaces, so the cut moves back to where that character starts.
	let end = Math.min(maxBytes, bytes.length);
	while (end > 0 && isContinuationByte(bytes[end])) end--;
	const cut = new TextDecoder().decode(bytes.subarray(0, end));
	const lastBreak = cut.lastIndexOf("\n");
	return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/** Whether `byte` continues a UTF-8 character rather than starting one. */
function isContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

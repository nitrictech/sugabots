import type { ModelMessage, ToolResultPart } from "ai";

/**
 * Keeps what a response's tool calls return within the context window of the
 * model reading them. History is bounded before a response starts; tool
 * results arrive during it, and every model call resends all of them, so a
 * response with large or many results would otherwise outgrow the window and
 * be refused by the provider.
 *
 * Every limit is a share of the window of the model reading the response.
 */

/**
 * A rough count, since there is no tokenizer for every provider. Tool results
 * are mostly JSON, identifiers and code, which take more tokens per character
 * than prose; counting them as English would let them overflow the window.
 */
const CHARACTERS_PER_TOKEN = 3;

/**
 * The most of the window any one tool result may fill. Enough that a whole
 * page from web_fetch fits in the window of any model with 128k tokens or
 * more, as it did before results were limited.
 */
const RESULT_SHARE = 0.2;

/**
 * The most tokens any one tool result may take, however large the window: an
 * agent works better from a narrow answer than from a huge one, and every
 * later model call in the response pays for it again.
 */
const MAX_RESULT_TOKENS = 25_000;

/** How much of a result that is cut short is kept from its start; the rest is its end, where errors usually are. */
const HEAD_SHARE = 0.8;

/** Past this share of the window, the oldest tool results are cleared. */
const CLEARING_LINE_SHARE = 0.7;

/**
 * How full the window is left once results are cleared. Well below the
 * clearing line, because clearing changes what earlier model calls sent and
 * so costs the provider's prompt cache: clearing a lot at once means it
 * happens rarely.
 */
const CLEARED_TO_SHARE = 0.5;

const CLEARED_NOTE =
	"[This result was cleared to keep the conversation within the model's context window. If you still need it, call the tool again with a narrower request.]";

/** A model call about to be made: the calls before it, with what each used, and the messages it will be sent. */
export interface NextCall {
	steps: ReadonlyArray<{ usage: { inputTokens: number | undefined } }>;
	messages: ModelMessage[];
}

/**
 * Fits the tool results of one response to the window, given each of its
 * model calls in turn, before the call is made. It returns the messages with
 * each tool result cut to its limit and, once the prompt is past the clearing
 * line, the oldest results replaced by a note saying they were cleared. The
 * tool calls themselves are kept, so the model still knows what it has done.
 * The call's own `messages` are returned when nothing changed.
 *
 * The prompt is measured as the previous call's, as its provider counted it,
 * plus an estimate of the messages added since. Without a previous call, or
 * a count from its provider, the system text and messages are estimated
 * whole. That is why it must be given every call of the response, and the
 * messages each call returns must be the ones sent on.
 */
export function toolResultFitter(
	windowTokens: number,
	system: string,
): (call: NextCall) => ModelMessage[] {
	const resultCharacters = Math.floor(
		Math.min(windowTokens * RESULT_SHARE, MAX_RESULT_TOKENS) * CHARACTERS_PER_TOKEN,
	);
	let sentMessageCount: number | undefined;
	return ({ steps, messages }) => {
		const cut = sameIfUnchanged(
			messages,
			messages.map((message) =>
				withResults(message, (output) => cutShort(output, resultCharacters)),
			),
		);
		const measuredTokens = steps.at(-1)?.usage.inputTokens;
		const promptTokens =
			sentMessageCount !== undefined && measuredTokens !== undefined
				? measuredTokens + messagesTokens(cut.slice(sentMessageCount))
				: estimatedTokens(system) + messagesTokens(cut);
		const fitted =
			promptTokens <= windowTokens * CLEARING_LINE_SHARE
				? cut
				: clearOldest(cut, promptTokens - windowTokens * CLEARED_TO_SHARE);
		sentMessageCount = fitted.length;
		return fitted;
	};
}

/** `messages` with the oldest tool results cleared until about `tokens` are freed. */
function clearOldest(messages: ModelMessage[], tokens: number): ModelMessage[] {
	let toFree = tokens;
	const cleared = messages.map((message) =>
		withResults(message, (output) => {
			const freed = estimatedTokens(outputText(output)) - estimatedTokens(CLEARED_NOTE);
			if (toFree <= 0 || freed <= 0) return output;
			toFree -= freed;
			return { type: "text", value: CLEARED_NOTE };
		}),
	);
	return sameIfUnchanged(messages, cleared);
}

/**
 * `output` cut to `maxCharacters`, keeping its start and end, with a note
 * where its middle was. A cut result is text, whatever it was, since cut JSON
 * no longer parses.
 */
function cutShort(
	output: ToolResultPart["output"],
	maxCharacters: number,
): ToolResultPart["output"] {
	const text = outputText(output);
	if (text.length <= maxCharacters) return output;
	// The note counts towards the limit, so a cut result fits it and is left
	// alone by later model calls. No more than the whole text is left out, so
	// the real note is no longer than one saying that.
	const keptCharacters = Math.max(
		0,
		maxCharacters - cutNote(text.length, text.length).length - 2 * CUT_SEPARATOR.length,
	);
	const headCharacters = Math.floor(keptCharacters * HEAD_SHARE);
	const tailCharacters = keptCharacters - headCharacters;
	const value = [
		text.slice(0, headCharacters),
		cutNote(text.length, text.length - keptCharacters),
		text.slice(text.length - tailCharacters),
	].join(CUT_SEPARATOR);
	switch (output.type) {
		case "error-text":
		case "error-json":
			return { type: "error-text", value };
		case "content":
			// Files, such as images, are kept: they are not counted as text.
			return {
				type: "content",
				value: [
					{ type: "text", text: value },
					...output.value.filter((part) => part.type !== "text"),
				],
			};
		default:
			return { type: "text", value };
	}
}

const CUT_SEPARATOR = "\n\n";

/** What the model is told in place of the middle of a result `characters` long. */
function cutNote(characters: number, leftOut: number): string {
	return `[This result was ${characters} characters, too long to show whole: ${leftOut} characters from its middle are left out. Don't treat it as complete. If you need what is missing, call the tool again with a narrower request, such as a filter, a smaller range or fewer items.]`;
}

/** The text of `output` the model reads, as far as it can be counted. */
function outputText(output: ToolResultPart["output"]): string {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value;
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "content":
			return output.value.map((part) => (part.type === "text" ? part.text : "")).join("");
		case "execution-denied":
			return output.reason ?? "";
	}
}

/**
 * The tokens `text` is estimated to take, at the rate tool results are counted
 * at. Prose takes fewer, so this errs on the side of a smaller prompt.
 */
function estimatedTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

function messagesTokens(messages: readonly ModelMessage[]): number {
	return messages.reduce((total, message) => total + estimatedTokens(messageText(message)), 0);
}

/** The text of `message` as far as it can be counted: a tool result by its output, anything else as JSON. */
function messageText(message: ModelMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => {
			if (part.type === "tool-result") return outputText(part.output);
			if (part.type === "file" || part.type === "image") return "";
			return JSON.stringify(part);
		})
		.join("");
}

/** `message` with `change` applied to each of its tool results' outputs; `message` itself when none changed. */
function withResults(
	message: ModelMessage,
	change: (output: ToolResultPart["output"]) => ToolResultPart["output"],
): ModelMessage {
	if (message.role !== "tool") return message;
	const content = message.content.map((part) => {
		if (part.type !== "tool-result") return part;
		const output = change(part.output);
		return output === part.output ? part : { ...part, output };
	});
	return content.every((part, index) => part === message.content[index])
		? message
		: { ...message, content };
}

/** `original` when `changed` holds the same messages, so a caller can tell nothing changed. */
function sameIfUnchanged(original: ModelMessage[], changed: ModelMessage[]): ModelMessage[] {
	return changed.every((message, index) => message === original[index]) ? original : changed;
}

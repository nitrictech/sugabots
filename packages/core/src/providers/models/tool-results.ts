import type { ModelMessage, ToolResultPart } from "ai";

/**
 * Keeps what a response's tool calls return within the context window of the
 * model reading them. History is bounded before a response starts; tool
 * results arrive during it, and every model call resends all of them, so a
 * response with large or many results would otherwise outgrow the window and
 * be refused by the provider.
 */

/**
 * A rough count, since every model has its own tokenizer. Tool results are
 * mostly JSON, identifiers and code: fetched JSON has been counted at about
 * 2.8 characters a token, so counting 2.5 keeps the estimate on the high side.
 */
const CHARACTERS_PER_TOKEN = 2.5;

/**
 * Characters a token when counting what clearing frees: more than
 * `CHARACTERS_PER_TOKEN`, so clearing is never credited with more room than
 * it made.
 */
const CHARACTERS_PER_FREED_TOKEN = 3.5;

/**
 * The most of the window any one tool result may fill. Enough that a
 * 44,000-character result, the most web_fetch returns, stays whole in a
 * window of 128k tokens or more.
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

/** Past this share of the window, {@link makeRoom} makes room in the prompt. */
const CLEARING_LINE_SHARE = 0.7;

/** How full the window is left once results are cleared, where clearing can get it that low. */
const CLEARED_TO_SHARE = 0.5;

/** The least of the window clearing must free to be worth doing. */
const MIN_CLEARED_SHARE = 0.1;

/**
 * The most of the window a call's prompt may fill. The rest is room for the
 * reply and for the estimate being wrong.
 */
const PROMPT_LIMIT_SHARE = 0.9;

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
 * line, room made as {@link makeRoom} says. The call's own `messages` are
 * returned when nothing changed.
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
				: sameIfUnchanged(cut, makeRoom(cut, promptTokens, windowTokens));
		sentMessageCount = fitted.length;
		return fitted;
	};
}

/**
 * makeRoom returns `messages`, whose prompt is past the clearing line at
 * `promptTokens`, with room made in it.
 *
 * Results the model has already read are cleared oldest first: each is
 * replaced by a note, and its tool call is kept so the model still knows what
 * it has done. Clearing changes what earlier model calls sent, which costs
 * the provider's prompt cache, so results are cleared in bulk or not at all.
 *
 * Results the model has not read yet, those after its last message, are
 * never cleared, since clearing them would only have it call for them again.
 * When they still don't fit, they are cut to share the room that is left.
 */
function makeRoom(
	messages: ModelMessage[],
	promptTokens: number,
	windowTokens: number,
): ModelMessage[] {
	const unreadFrom = messages.findLastIndex((message) => message.role === "assistant") + 1;
	const read = messages.slice(0, unreadFrom);
	const unread = messages.slice(unreadFrom);
	const promptLimitTokens = windowTokens * PROMPT_LIMIT_SHARE;

	const wantedTokens = promptTokens - windowTokens * CLEARED_TO_SHARE;
	const clearableTokens = sum(resultOutputs(read).map(tokensFreedByClearing));
	const worthClearing =
		Math.min(wantedTokens, clearableTokens) >= windowTokens * MIN_CLEARED_SHARE ||
		promptTokens > promptLimitTokens;
	const cleared = worthClearing
		? clearOldest(read, wantedTokens)
		: { messages: read, freedTokens: 0 };

	const overflowTokens = promptTokens - cleared.freedTokens - promptLimitTokens;
	const unreadTokens = resultOutputs(unread).map((output) => estimatedTokens(outputText(output)));
	if (overflowTokens <= 0 || unreadTokens.length === 0) return [...cleared.messages, ...unread];
	const tokensPerResult = sharedLimit(unreadTokens, sum(unreadTokens) - overflowTokens);
	const charactersPerResult = Math.floor(tokensPerResult * CHARACTERS_PER_TOKEN);
	return [
		...cleared.messages,
		...unread.map((message) =>
			withResults(message, (output) => cutShort(output, charactersPerResult)),
		),
	];
}

/**
 * The most tokens each result may keep so that results of `sizes` fit in
 * `room`: results smaller than their share are kept whole, and what they
 * leave is shared by the rest.
 */
function sharedLimit(sizes: readonly number[], room: number): number {
	const smallestFirst = [...sizes].sort((a, b) => a - b);
	let left = Math.max(0, room);
	for (const [index, size] of smallestFirst.entries()) {
		const share = left / (smallestFirst.length - index);
		if (size > share) return share;
		left -= size;
	}
	return Number.POSITIVE_INFINITY;
}

/** `messages` with their oldest tool results cleared until about `tokens` are freed, and how many were. */
function clearOldest(
	messages: ModelMessage[],
	tokens: number,
): { messages: ModelMessage[]; freedTokens: number } {
	let freedTokens = 0;
	const cleared = messages.map((message) =>
		withResults(message, (output) => {
			const freed = tokensFreedByClearing(output);
			if (freedTokens >= tokens || freed <= 0) return output;
			freedTokens += freed;
			return { type: "text", value: CLEARED_NOTE };
		}),
	);
	return { messages: cleared, freedTokens };
}

function tokensFreedByClearing(output: ToolResultPart["output"]): number {
	const freedCharacters = outputText(output).length - CLEARED_NOTE.length;
	return Math.max(0, Math.floor(freedCharacters / CHARACTERS_PER_FREED_TOKEN));
}

/** The outputs of the tool results in `messages`, oldest first. */
function resultOutputs(messages: readonly ModelMessage[]): ToolResultPart["output"][] {
	return messages.flatMap((message) =>
		message.role === "tool"
			? message.content.flatMap((part) => (part.type === "tool-result" ? [part.output] : []))
			: [],
	);
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
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
	// alone by later model calls.
	const longestNote = cutNote(text.length, text.length);
	const keptCharacters = Math.max(0, maxCharacters - longestNote.length - 2 * CUT_SEPARATOR.length);
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

/** The text of `output` the model reads. Files, such as images, count as no text. */
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

/** The tokens `text` is estimated to take, at the rate tool results are counted at. */
function estimatedTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

function messagesTokens(messages: readonly ModelMessage[]): number {
	return messages.reduce((total, message) => total + estimatedTokens(messageText(message)), 0);
}

/** The text of `message`: a tool result's as {@link outputText} has it, files as none, anything else as JSON. */
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

/** `original` when `changed` holds the same messages, so `===` against `original` reports whether anything changed. */
function sameIfUnchanged(original: ModelMessage[], changed: ModelMessage[]): ModelMessage[] {
	return changed.every((message, index) => message === original[index]) ? original : changed;
}

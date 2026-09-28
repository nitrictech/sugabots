/**
 * How much of a model's context window a thread may fill, and where the
 * Compaction agent cuts it when it gets long. Every limit is a share of the
 * window of the model reading the thread.
 */

/**
 * The largest window any model is treated as having, and the window of a
 * model whose size is unknown. Models with more room still compact here:
 * answers degrade as the prompt grows long, and every token of it is paid for.
 */
export const MAX_CONTEXT_WINDOW_TOKENS = 256_000;

/** The window a model is treated as having, from the context length its provider reports. */
export function contextWindowTokens(contextLength: number | null | undefined): number {
	return contextLength
		? Math.min(contextLength, MAX_CONTEXT_WINDOW_TOKENS)
		: MAX_CONTEXT_WINDOW_TOKENS;
}

/** Past this share of the window in a turn's prompt, the Compaction agent compacts the thread. */
const COMPACTION_LINE_SHARE = 0.7;

/** How much of the newest history the bot keeps reading word for word after compacting. */
const KEPT_SHARE = 0.25;

/**
 * The most history a turn is shown whether or not the thread has been
 * compacted, below the window so the system text, tools and reply still fit.
 * Compaction keeps a thread well under this; it is what stops a thread from
 * overflowing when the Compaction agent has no model or has not caught up.
 */
const HISTORY_LIMIT_SHARE = 0.9;

/**
 * How much of its own window the Compaction agent's model may be given to
 * summarise. The rest holds its instructions, the previous summary, the
 * summary it writes, and the error in estimating tokens.
 */
const SUMMARISER_INPUT_SHARE = 0.6;

/** Past this many tokens in a turn's prompt, the Compaction agent compacts the thread. */
export function compactionLineTokens(windowTokens: number): number {
	return Math.floor(windowTokens * COMPACTION_LINE_SHARE);
}

/** The most history a turn reading with this window is shown. */
export function historyLimitTokens(windowTokens: number): number {
	return Math.floor(windowTokens * HISTORY_LIMIT_SHARE);
}

/**
 * A rough count, since there is no tokenizer for every provider. English
 * averages about four characters a token; the compaction line itself is
 * measured with the provider's own count.
 */
const CHARACTERS_PER_TOKEN = 4;

export function estimatedTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

/**
 * Whether a turn whose prompt measured `contextTokens`, read by a model with
 * this window, should have its thread compacted.
 */
export function needsCompaction(contextTokens: number | undefined, windowTokens: number): boolean {
	return contextTokens !== undefined && contextTokens >= compactionLineTokens(windowTokens);
}

/**
 * The newest items whose tokens add up to at most `limit`, oldest first. The
 * newest item is always included, however large.
 */
export function newestWithinLimit<Item>(
	items: readonly Item[],
	tokensOf: (item: Item) => number,
	limit: number,
): Item[] {
	let total = 0;
	let start = items.length;
	while (start > 0) {
		const tokens = tokensOf(items[start - 1] as Item);
		if (start < items.length && total + tokens > limit) break;
		total += tokens;
		start -= 1;
	}
	return items.slice(start);
}

export interface CompactionPlan<Message> {
	/** The messages the Compaction agent summarises, oldest first. */
	summarised: Message[];
	/** When the first summarised message was written: history before it is left out. */
	historyStartsAt: Date;
	/** When the first message kept word for word was written. */
	keptFrom: Date;
}

/**
 * Where to cut a thread's history, oldest first: the newest messages are kept
 * word for word, and the ones just before them are summarised. Nothing before
 * `previousKeptFrom` is summarised again, since the last compaction already
 * folded it into its summary. Nothing is planned when there is nothing to
 * summarise, such as when the newest messages alone fill what is kept.
 *
 * What is kept and summarised is sized to the window of the bot reading the
 * thread: at the compaction line, the bot read about what is kept plus what is
 * summarised. What is summarised is also capped to what the Compaction agent's
 * own model can read.
 */
export function planCompaction<Message extends { createdAt: Date; tokens: number }>(
	history: readonly Message[],
	previousKeptFrom: Date | undefined,
	windows: { readerTokens: number; summariserTokens: number },
): CompactionPlan<Message> | undefined {
	const keptTokens = Math.floor(windows.readerTokens * KEPT_SHARE);
	const summarisedTokens = Math.min(
		compactionLineTokens(windows.readerTokens) - keptTokens,
		Math.floor(windows.summariserTokens * SUMMARISER_INPUT_SHARE),
	);
	const kept = newestWithinLimit(history, (message) => message.tokens, keptTokens);
	const beforeKept = history
		.slice(0, history.length - kept.length)
		.filter((message) => !previousKeptFrom || message.createdAt >= previousKeptFrom);
	const summarised = newestWithinLimit(beforeKept, (message) => message.tokens, summarisedTokens);
	const [firstSummarised] = summarised;
	const [firstKept] = kept;
	// The newest message before what is kept is always taken, so a single one
	// larger than the Compaction agent may read leaves it nothing it can summarise.
	if (!firstSummarised || !firstKept || firstSummarised.tokens > summarisedTokens) {
		return undefined;
	}
	return {
		summarised,
		historyStartsAt: firstSummarised.createdAt,
		keptFrom: firstKept.createdAt,
	};
}

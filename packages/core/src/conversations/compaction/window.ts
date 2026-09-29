/**
 * Where the Compaction agent cuts a thread when it gets long. Every limit is
 * a share of the window of the model reading the thread.
 */

import { newestWithinLimit } from "../context-window.ts";

/** Past this share of the window in a turn's prompt, the Compaction agent compacts the thread. */
const COMPACTION_LINE_SHARE = 0.7;

/** How much of the newest history the bot keeps reading word for word after compacting. */
const KEPT_SHARE = 0.25;

/**
 * How much of its own window the model compacting a thread may be given to
 * summarise. The rest holds its instructions, the previous summary, the
 * summary it writes, and the error in estimating tokens.
 */
const SUMMARISER_INPUT_SHARE = 0.6;

/** Past this many tokens in a turn's prompt, the Compaction agent compacts the thread. */
export function compactionLineTokens(windowTokens: number): number {
	return Math.floor(windowTokens * COMPACTION_LINE_SHARE);
}

/**
 * Whether a turn whose prompt measured `contextTokens`, read by a model with
 * this window, should have its thread compacted.
 */
export function needsCompaction(contextTokens: number | undefined, windowTokens: number): boolean {
	return contextTokens !== undefined && contextTokens >= compactionLineTokens(windowTokens);
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
 * summarised. What is summarised is also capped to what the model summarising
 * it can read.
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

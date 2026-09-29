import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { providerModel } from "../../database/schema.ts";

/**
 * How much of a model's context window a thread may fill. Every limit is a
 * share of the window of the model reading the thread.
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

/**
 * The most history a turn is shown whether or not the thread has been
 * compacted, below the window so the system text, tools and reply still fit.
 * Compaction keeps a thread well under this; it is what stops a thread from
 * overflowing when there is no model to compact it with or compaction has
 * not caught up.
 */
const HISTORY_LIMIT_SHARE = 0.9;

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

/**
 * The window a workspace's model is treated as having: the context length its
 * provider reports, capped at `MAX_CONTEXT_WINDOW_TOKENS`, or that cap when the
 * model is not listed or its length is unknown.
 */
export const loadContextWindow = Effect.fn("ContextWindow.loadContextWindow")(function* (
	db: Executor,
	workspaceId: string,
	modelId: string,
) {
	const [row] = yield* db
		.select({ contextLength: providerModel.contextLength })
		.from(providerModel)
		.where(and(eq(providerModel.workspaceId, workspaceId), eq(providerModel.modelId, modelId)))
		.limit(1);
	return contextWindowTokens(row?.contextLength);
});

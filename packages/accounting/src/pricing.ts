import type { Cost, ModelCost } from "@opencode-ai/models";
import { Brand } from "effect";
import type { RequestUsage } from "./usage.ts";
import { Usd } from "./usd.ts";

/** What a model charges for one token of each kind, in US dollars. */
export interface TokenPrices {
	readonly input: number;
	readonly output: number;
	/** Absent when the provider publishes no separate price, and the input price applies. */
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	/** Absent when reasoning is charged as output. */
	readonly reasoning?: number;
}

/**
 * A model's prices. Some models charge more once a request's input is long:
 * a request whose input is over a tier's `overInputTokens` is charged that
 * tier's prices. Only {@link ratesFromModelsDev} makes one, so the tiers are
 * always in order.
 */
export type Rates = Brand.Branded<
	{
		readonly base: TokenPrices;
		/** Ordered by `overInputTokens`, lowest first. */
		readonly longContext: readonly LongContextTier[];
	},
	"Rates"
>;

const Rates = Brand.nominal<Rates>();

export interface LongContextTier {
	readonly overInputTokens: number;
	readonly prices: TokenPrices;
}

/** What one request cost, or why it can't be said. An unknown cost is never reported as zero. */
export type CostEstimate =
	| { readonly _tag: "Priced"; readonly usd: Usd }
	| { readonly _tag: "Unpriced"; readonly reason: UnpricedReason };

export type UnpricedReason =
	/** The provider did not report the input or output token count. */
	| "usage-not-reported"
	/** The provider's counts contradict each other, such as more cached tokens than input tokens. */
	| "usage-inconsistent";

/** The long-context threshold models.dev's deprecated `context_over_200k` field names. */
const LEGACY_LONG_CONTEXT_TOKENS = 200_000;

/** A model's rates from its models.dev `cost` entry. */
export function ratesFromModelsDev(cost: ModelCost): Rates {
	const longContext: LongContextTier[] = cost.tiers
		? cost.tiers.map((tier) => ({ overInputTokens: tier.tier.size, prices: pricesOf(tier) }))
		: cost.context_over_200k
			? [
					{
						overInputTokens: LEGACY_LONG_CONTEXT_TOKENS,
						prices: pricesOf(cost.context_over_200k),
					},
				]
			: [];
	return Rates({
		base: pricesOf(cost),
		longContext: longContext.toSorted(
			(left, right) => left.overInputTokens - right.overInputTokens,
		),
	});
}

/** models.dev quotes each price for this many tokens. */
const MODELS_DEV_QUOTED_TOKENS = 1_000_000;

function pricesOf(cost: Cost): TokenPrices {
	const perToken = (quoted: number) => quoted / MODELS_DEV_QUOTED_TOKENS;
	return {
		input: perToken(cost.input),
		output: perToken(cost.output),
		...(cost.cache_read === undefined ? {} : { cacheRead: perToken(cost.cache_read) }),
		...(cost.cache_write === undefined ? {} : { cacheWrite: perToken(cost.cache_write) }),
		...(cost.reasoning === undefined ? {} : { reasoning: perToken(cost.reasoning) }),
	};
}

/**
 * What one request cost at these rates.
 *
 * A cache count the provider left out is taken as none: providers that don't
 * report cache writes don't charge for them apart from input. A cached token
 * with no published cache price is charged as input, which is what it would
 * have cost uncached.
 */
export function estimateCost(usage: RequestUsage, rates: Rates): CostEstimate {
	const { inputTokens, outputTokens } = usage;
	if (inputTokens === undefined || outputTokens === undefined) {
		return { _tag: "Unpriced", reason: "usage-not-reported" };
	}
	const cacheReadTokens = usage.cacheReadTokens ?? 0;
	const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
	const uncachedInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
	const reasoningTokens = usage.reasoningTokens ?? 0;
	if (uncachedInputTokens < 0 || reasoningTokens > outputTokens) {
		return { _tag: "Unpriced", reason: "usage-inconsistent" };
	}

	const prices =
		rates.longContext.findLast((tier) => inputTokens > tier.overInputTokens)?.prices ?? rates.base;
	const pricedTokens: readonly (readonly [tokens: number, usdPerToken: number])[] = [
		[uncachedInputTokens, prices.input],
		[cacheReadTokens, prices.cacheRead ?? prices.input],
		[cacheWriteTokens, prices.cacheWrite ?? prices.input],
		[outputTokens - reasoningTokens, prices.output],
		[reasoningTokens, prices.reasoning ?? prices.output],
	];
	const usd = pricedTokens.reduce(
		(total, [tokens, usdPerToken]) => total + tokens * usdPerToken,
		0,
	);
	return { _tag: "Priced", usd: Usd.make(usd) };
}

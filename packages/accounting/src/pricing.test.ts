import type { ModelCost } from "@opencode-ai/models";
import { describe, expect, it } from "vitest";
import { type CostEstimate, estimateCost, ratesFromModelsDev } from "./pricing.ts";
import type { RequestUsage } from "./usage.ts";

/** Shaped like a models.dev entry for a model with prompt caching and a long-context tier. */
const cachingModel: ModelCost = {
	input: 3,
	output: 15,
	cache_read: 0.3,
	cache_write: 3.75,
	tiers: [
		{
			tier: { type: "context", size: 200_000 },
			input: 6,
			output: 22.5,
			cache_read: 0.6,
			cache_write: 7.5,
		},
	],
};

const noUsage: RequestUsage = {
	inputTokens: undefined,
	cacheReadTokens: undefined,
	cacheWriteTokens: undefined,
	outputTokens: undefined,
	reasoningTokens: undefined,
};

function usage(counts: Partial<RequestUsage>): RequestUsage {
	return { ...noUsage, ...counts };
}

function pricedUsd(estimate: CostEstimate): number {
	if (estimate._tag !== "Priced") throw new Error(`Expected a price, got ${estimate.reason}`);
	return estimate.usd;
}

describe("estimateCost", () => {
	it("charges input and output at their prices per million tokens", () => {
		const rates = ratesFromModelsDev({ input: 3, output: 15 });
		const estimate = estimateCost(usage({ inputTokens: 1_000_000, outputTokens: 100_000 }), rates);
		expect(pricedUsd(estimate)).toBeCloseTo(3 + 1.5);
	});

	it("charges cached input at the cache prices and the rest at the input price", () => {
		const estimate = estimateCost(
			usage({
				inputTokens: 100_000,
				cacheReadTokens: 60_000,
				cacheWriteTokens: 20_000,
				outputTokens: 0,
			}),
			ratesFromModelsDev(cachingModel),
		);
		expect(pricedUsd(estimate)).toBeCloseTo(0.02 * 3 + 0.06 * 0.3 + 0.02 * 3.75);
	});

	it("charges cached input as input when the model publishes no cache price", () => {
		const estimate = estimateCost(
			usage({ inputTokens: 100_000, cacheReadTokens: 60_000, outputTokens: 0 }),
			ratesFromModelsDev({ input: 3, output: 15 }),
		);
		expect(pricedUsd(estimate)).toBeCloseTo(0.3);
	});

	it("charges a request at a long-context tier once its input is over the tier's size", () => {
		const rates = ratesFromModelsDev(cachingModel);
		const at = estimateCost(usage({ inputTokens: 200_000, outputTokens: 0 }), rates);
		const over = estimateCost(usage({ inputTokens: 200_001, outputTokens: 0 }), rates);
		expect(pricedUsd(at)).toBeCloseTo(0.2 * 3);
		expect(pricedUsd(over)).toBeCloseTo(0.200_001 * 6);
	});

	it("reads the deprecated long-context price when a model has no tiers", () => {
		const rates = ratesFromModelsDev({
			input: 1,
			output: 2,
			context_over_200k: { input: 10, output: 20 },
		});
		const estimate = estimateCost(usage({ inputTokens: 300_000, outputTokens: 0 }), rates);
		expect(pricedUsd(estimate)).toBeCloseTo(3);
	});

	it("charges reasoning at its own price when there is one, and as output otherwise", () => {
		const counts = usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 400_000 });
		const separate = estimateCost(
			counts,
			ratesFromModelsDev({ input: 1, output: 10, reasoning: 5 }),
		);
		const asOutput = estimateCost(counts, ratesFromModelsDev({ input: 1, output: 10 }));
		expect(pricedUsd(separate)).toBeCloseTo(0.6 * 10 + 0.4 * 5);
		expect(pricedUsd(asOutput)).toBeCloseTo(10);
	});

	it("prices a free model at zero", () => {
		const estimate = estimateCost(
			usage({ inputTokens: 5_000, outputTokens: 500 }),
			ratesFromModelsDev({ input: 0, output: 0 }),
		);
		expect(estimate).toEqual({ _tag: "Priced", usd: 0 });
	});

	it("leaves a request unpriced when the provider did not report its tokens", () => {
		const rates = ratesFromModelsDev(cachingModel);
		expect(estimateCost(usage({ outputTokens: 10 }), rates)).toEqual({
			_tag: "Unpriced",
			reason: "usage-not-reported",
		});
		expect(estimateCost(usage({ inputTokens: 10 }), rates)).toEqual({
			_tag: "Unpriced",
			reason: "usage-not-reported",
		});
	});

	it("leaves a request unpriced when its counts contradict each other", () => {
		const rates = ratesFromModelsDev(cachingModel);
		expect(
			estimateCost(usage({ inputTokens: 10, cacheReadTokens: 20, outputTokens: 0 }), rates),
		).toEqual({ _tag: "Unpriced", reason: "usage-inconsistent" });
		expect(
			estimateCost(usage({ inputTokens: 0, outputTokens: 10, reasoningTokens: 20 }), rates),
		).toEqual({ _tag: "Unpriced", reason: "usage-inconsistent" });
	});
});

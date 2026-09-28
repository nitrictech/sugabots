import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import { openRouterReportedCost, usageFromAiSdk } from "./usage.ts";

function sdkUsage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
	return {
		inputTokens: 1_200,
		inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 100 },
		outputTokens: 300,
		outputTokenDetails: { textTokens: 250, reasoningTokens: 50 },
		totalTokens: 1_500,
		...overrides,
	};
}

describe("usageFromAiSdk", () => {
	it("keeps the counts that pricing needs", () => {
		expect(usageFromAiSdk(sdkUsage())).toEqual({
			inputTokens: 1_200,
			cacheReadTokens: 900,
			cacheWriteTokens: 100,
			outputTokens: 300,
			reasoningTokens: 50,
		});
	});

	it("treats a count that is not a whole number of tokens as unreported", () => {
		const usage = usageFromAiSdk(sdkUsage({ inputTokens: -1, outputTokens: Number.NaN }));
		expect(usage.inputTokens).toBeUndefined();
		expect(usage.outputTokens).toBeUndefined();
	});
});

describe("openRouterReportedCost", () => {
	it("reads the cost OpenRouter returns in its usage", () => {
		expect(openRouterReportedCost(sdkUsage({ raw: { prompt_tokens: 1_200, cost: 0.0042 } }))).toBe(
			0.0042,
		);
	});

	it("adds what the provider charged when the request used the workspace's own key", () => {
		const byok = sdkUsage({
			raw: { cost: 0.0002, cost_details: { upstream_inference_cost: 0.004 } },
		});
		expect(openRouterReportedCost(byok)).toBeCloseTo(0.0042);
	});

	it("is undefined when no usable cost was returned", () => {
		expect(openRouterReportedCost(sdkUsage())).toBeUndefined();
		expect(openRouterReportedCost(sdkUsage({ raw: { cost: "0.0042" } }))).toBeUndefined();
		expect(openRouterReportedCost(sdkUsage({ raw: { cost: -1 } }))).toBeUndefined();
	});
});

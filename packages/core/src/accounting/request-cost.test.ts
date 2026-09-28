import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import type { ProviderIdentity } from "../providers/model-providers/dialects/index.ts";
import { requestCost } from "./request-cost.ts";

const usage = (raw?: LanguageModelUsage["raw"]): LanguageModelUsage => ({
	inputTokens: 1_000_000,
	inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
	outputTokens: 100_000,
	outputTokenDetails: { textTokens: 100_000, reasoningTokens: 0 },
	totalTokens: 1_100_000,
	...(raw ? { raw } : {}),
});

const registry = {
	version: "models.dev@test",
	cost: (model: string) => (model === "priced" ? { input: 3, output: 15 } : undefined),
};

const provider = (preset: ProviderIdentity["preset"]): ProviderIdentity => ({
	preset,
	baseUrl: "https://models.example/v1",
	apiFormat: "openai",
});

describe("requestCost", () => {
	it("prices a request from the registry's published rates", () => {
		const cost = requestCost(provider("anthropic"), "priced", usage(), registry);
		expect(cost?.source).toBe("models.dev@test");
		expect(cost?.usd).toBeCloseTo(3 + 1.5);
	});

	it("leaves a model with no published price unpriced", () => {
		expect(requestCost(provider("anthropic"), "unlisted", usage(), registry)).toBeUndefined();
		expect(requestCost(provider(null), "unlisted", usage(), registry)).toBeUndefined();
	});

	it("charges nothing for a server the workspace runs itself", () => {
		expect(requestCost(provider("ollama"), "priced", usage(), registry)).toEqual({
			usd: 0,
			source: "local",
		});
	});

	it("charges nothing per request for a ChatGPT subscription", () => {
		expect(requestCost(provider("chatgpt"), "priced", usage(), registry)).toEqual({
			usd: 0,
			source: "subscription",
		});
	});

	it("believes OpenRouter's own figure over the published rates", () => {
		expect(requestCost(provider("openrouter"), "priced", usage({ cost: 0.25 }), registry)).toEqual({
			usd: 0.25,
			source: "provider-reported",
		});
		expect(requestCost(provider("openrouter"), "priced", usage(), registry)?.source).toBe(
			"models.dev@test",
		);
	});
});

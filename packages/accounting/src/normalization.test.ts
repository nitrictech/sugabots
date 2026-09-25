import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import { evidenceFromAiSdkUsage } from "./ai-sdk.ts";
import { normalizeUsage } from "./normalization.ts";
import type { UsageEvidence } from "./schemas.ts";
import { partialUsageEvidence } from "./test-fixtures.ts";

describe("usage normalization", () => {
	it("distinguishes absent cache evidence from an explicit zero", () => {
		const withoutDetails = evidenceFromAiSdkUsage("openai", usage({ prompt_tokens: 10 }));
		const withZero = evidenceFromAiSdkUsage(
			"openai",
			usage({
				prompt_tokens: 10,
				prompt_tokens_details: { cached_tokens: 0 },
			}),
		);

		expect(withoutDetails.counters.cacheReadInputTokens).toBeUndefined();
		expect(withoutDetails.counters.uncachedInputTokens).toBeUndefined();
		expect(withZero.counters.cacheReadInputTokens).toBe(0);
		expect(withZero.counters.uncachedInputTokens).toBe(10);
	});

	it("preserves only allowlisted provider usage fields", () => {
		const evidence = evidenceFromAiSdkUsage(
			"openai",
			usage({
				prompt_tokens: 10,
				secret: "do not retain",
				prompt_tokens_details: { cached_tokens: 2, vendor_secret: "no" },
			}),
		);

		expect(evidence.raw).toEqual({
			prompt_tokens: 10,
			prompt_tokens_details: { cached_tokens: 2 },
		});
	});

	it("flags overlapping counters instead of clamping them", () => {
		const evidence: UsageEvidence = {
			normalizationVersion: 1,
			source: { kind: "manual", name: "fixture" },
			counters: {
				inputTokens: 10,
				uncachedInputTokens: 8,
				cacheReadInputTokens: 4,
				outputTokens: 3,
				reasoningTokens: 5,
			},
		};

		const normalized = normalizeUsage(evidence);

		expect(normalized.completeness).toBe("partial");
		expect(normalized.issues.map((issue) => issue.code)).toEqual([
			"input-components-exceed-total",
			"reasoning-exceeds-output",
		]);
		expect(normalized.counters).toEqual(evidence.counters);
	});

	it("reports usage without an output total as partial", () => {
		expect(normalizeUsage(partialUsageEvidence).completeness).toBe("partial");
	});

	it("keeps Anthropic cache writes and flags model-scoped iterations", () => {
		const evidence = evidenceFromAiSdkUsage(
			"anthropic",
			usage({
				input_tokens: 8,
				output_tokens: 2,
				cache_creation_input_tokens: 3,
				cache_read_input_tokens: 4,
				iterations: [
					{ type: "advisor_message", model: "advisor", input_tokens: 1, output_tokens: 1 },
				],
			}),
		);
		const normalized = normalizeUsage(evidence);

		expect(normalized.counters).toEqual(
			expect.objectContaining({
				inputTokens: 15,
				uncachedInputTokens: 8,
				cacheReadInputTokens: 4,
				cacheWriteInputTokens: 3,
			}),
		);
		expect(normalized.issues).toContainEqual(
			expect.objectContaining({ code: "unsupported-provider-evidence" }),
		);
	});
});

function usage(raw: Record<string, unknown>): LanguageModelUsage {
	const prompt = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 15;
	const output = typeof raw.output_tokens === "number" ? raw.output_tokens : 2;
	const cached = (raw.prompt_tokens_details as { cached_tokens?: number } | undefined)
		?.cached_tokens;
	return {
		inputTokens: prompt,
		inputTokenDetails: {
			noCacheTokens: prompt - (cached ?? 0),
			cacheReadTokens: cached ?? 0,
			cacheWriteTokens: undefined,
		},
		outputTokens: output,
		outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
		totalTokens: prompt + output,
		raw: raw as LanguageModelUsage["raw"],
	};
}

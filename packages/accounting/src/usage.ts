import type { LanguageModelUsage } from "ai";
import { Usd } from "./usd.ts";

/**
 * The tokens one provider request used, as the provider counted them. A count
 * the provider did not report is `undefined`, never zero.
 */
export interface RequestUsage {
	/** Every input token, whether read from the cache, written to it, or neither. */
	readonly inputTokens: number | undefined;
	readonly cacheReadTokens: number | undefined;
	readonly cacheWriteTokens: number | undefined;
	/** Every output token, reasoning included. */
	readonly outputTokens: number | undefined;
	readonly reasoningTokens: number | undefined;
}

/**
 * The usage of one AI SDK step. The SDK has already normalised each provider's
 * counts into the same shape; a count that is not a whole number of tokens is
 * treated as unreported.
 */
export function usageFromAiSdk(usage: LanguageModelUsage): RequestUsage {
	return {
		inputTokens: tokenCount(usage.inputTokens),
		cacheReadTokens: tokenCount(usage.inputTokenDetails.cacheReadTokens),
		cacheWriteTokens: tokenCount(usage.inputTokenDetails.cacheWriteTokens),
		outputTokens: tokenCount(usage.outputTokens),
		reasoningTokens: tokenCount(usage.outputTokenDetails.reasoningTokens),
	};
}

/**
 * What OpenRouter says a request cost, in US dollars, from the usage it
 * returns. `cost` is what OpenRouter charged; when the request used the
 * workspace's own provider key, the provider charged the rest itself, as
 * `cost_details.upstream_inference_cost`. `undefined` when it did not say.
 */
export function openRouterReportedCost(usage: LanguageModelUsage): Usd | undefined {
	const raw = usage.raw;
	const charged = amount(raw?.cost);
	if (charged === undefined) return undefined;
	const details = raw?.cost_details;
	const upstream = isRecord(details) ? amount(details.upstream_inference_cost) : undefined;
	return Usd.make(charged + (upstream ?? 0));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function amount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokenCount(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

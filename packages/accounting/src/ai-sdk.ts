import type { LanguageModelUsage } from "ai";
import type { Schema } from "effect";
import type { UsageCounters, UsageEvidence } from "./schemas.ts";

type JsonValue = Schema.Json;

/** The provider response shape inside the AI SDK's raw usage. */
export type AiSdkProviderFormat = "anthropic" | "openai";

/** Keeps only token-count fields of the raw usage, so no response content is retained. */
export function evidenceFromAiSdkUsage(
	format: AiSdkProviderFormat,
	usage: LanguageModelUsage,
): UsageEvidence {
	const raw = allowlistedRawUsage(format, usage.raw);
	return {
		normalizationVersion: 1,
		source: { kind: "ai-sdk", name: format },
		counters: format === "openai" ? openAiCounters(usage) : anthropicCounters(usage),
		...(hasAnthropicIterations(raw) ? { containsProviderSubrequests: true } : {}),
		...(raw === undefined ? {} : { raw }),
	};
}

function hasAnthropicIterations(raw: { [key: string]: JsonValue } | undefined): boolean {
	return Array.isArray(raw?.iterations) && raw.iterations.length > 0;
}

function openAiCounters(usage: LanguageModelUsage): UsageCounters {
	const raw = asObject(usage.raw);
	const inputDetails = asObject(raw?.prompt_tokens_details ?? raw?.input_tokens_details);
	const outputDetails = asObject(raw?.completion_tokens_details ?? raw?.output_tokens_details);
	const cacheRead = numberOrUndefined(inputDetails?.cached_tokens);
	const cacheWrite = numberOrUndefined(inputDetails?.cache_write_tokens);
	return {
		inputTokens: usage.inputTokens,
		uncachedInputTokens:
			cacheRead === undefined ? undefined : usage.inputTokenDetails.noCacheTokens,
		cacheReadInputTokens: cacheRead,
		cacheWriteInputTokens: cacheWrite,
		outputTokens: usage.outputTokens,
		reasoningTokens: numberOrUndefined(outputDetails?.reasoning_tokens),
	};
}

function anthropicCounters(usage: LanguageModelUsage): UsageCounters {
	const raw = asObject(usage.raw);
	return {
		inputTokens: usage.inputTokens,
		uncachedInputTokens: numberOrUndefined(raw?.input_tokens),
		cacheReadInputTokens: numberOrUndefined(raw?.cache_read_input_tokens),
		cacheWriteInputTokens: numberOrUndefined(raw?.cache_creation_input_tokens),
		outputTokens: usage.outputTokens,
		reasoningTokens: numberOrUndefined(asObject(raw?.output_tokens_details)?.thinking_tokens),
	};
}

function allowlistedRawUsage(
	format: AiSdkProviderFormat,
	raw: LanguageModelUsage["raw"],
): { [key: string]: JsonValue } | undefined {
	const source = asObject(raw);
	if (!source) return undefined;
	return format === "openai" ? allowOpenAi(source) : allowAnthropic(source);
}

function allowOpenAi(source: Record<string, unknown>): { [key: string]: JsonValue } {
	return compact({
		prompt_tokens: numberOrUndefined(source.prompt_tokens),
		input_tokens: numberOrUndefined(source.input_tokens),
		completion_tokens: numberOrUndefined(source.completion_tokens),
		output_tokens: numberOrUndefined(source.output_tokens),
		total_tokens: numberOrUndefined(source.total_tokens),
		prompt_tokens_details: allowNumberFields(source.prompt_tokens_details, [
			"cached_tokens",
			"cache_write_tokens",
		]),
		input_tokens_details: allowNumberFields(source.input_tokens_details, [
			"cached_tokens",
			"cache_write_tokens",
		]),
		completion_tokens_details: allowNumberFields(source.completion_tokens_details, [
			"reasoning_tokens",
			"accepted_prediction_tokens",
			"rejected_prediction_tokens",
		]),
		output_tokens_details: allowNumberFields(source.output_tokens_details, ["reasoning_tokens"]),
	});
}

function allowAnthropic(source: Record<string, unknown>): { [key: string]: JsonValue } {
	const iterations = Array.isArray(source.iterations)
		? source.iterations.flatMap((value) => {
				const iteration = asObject(value);
				if (!iteration) return [];
				const type = stringOrUndefined(iteration.type);
				if (!type) return [];
				return [
					compact({
						type,
						model: stringOrUndefined(iteration.model),
						input_tokens: numberOrUndefined(iteration.input_tokens),
						output_tokens: numberOrUndefined(iteration.output_tokens),
						cache_creation_input_tokens: numberOrUndefined(iteration.cache_creation_input_tokens),
						cache_read_input_tokens: numberOrUndefined(iteration.cache_read_input_tokens),
					}),
				];
			})
		: undefined;
	return compact({
		input_tokens: numberOrUndefined(source.input_tokens),
		output_tokens: numberOrUndefined(source.output_tokens),
		cache_creation_input_tokens: numberOrUndefined(source.cache_creation_input_tokens),
		cache_read_input_tokens: numberOrUndefined(source.cache_read_input_tokens),
		output_tokens_details: allowNumberFields(source.output_tokens_details, ["thinking_tokens"]),
		iterations,
	});
}

function allowNumberFields(
	value: unknown,
	fields: readonly string[],
): { [key: string]: JsonValue } | undefined {
	const source = asObject(value);
	if (!source) return undefined;
	const allowed = compact(
		Object.fromEntries(fields.map((field) => [field, numberOrUndefined(source[field])])),
	);
	return Object.keys(allowed).length > 0 ? allowed : undefined;
}

function compact(values: Record<string, JsonValue | undefined>): { [key: string]: JsonValue } {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
	);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

import { getModelCapabilities } from "@ai-sdk/anthropic/internal";
import { getGoogleLanguageModelEntry } from "@ai-sdk/google/internal";
import { openaiModelCatalog } from "@ai-sdk/openai/internal";
import { geminiModelId } from "../model-providers/dialects/gemini.ts";

export function claudeSupportsAdaptiveThinking(modelId: string): boolean {
	const capabilities = getModelCapabilities(modelId);
	return capabilities.isKnownModel && capabilities.supportsAdaptiveThinking;
}

export function geminiThinkingFormat(modelId: string): "budget" | "level" {
	return getGoogleLanguageModelEntry(geminiModelId(modelId)).requestConfig.language.thinkingFormat;
}

export function openAIThinkingSupport(modelId: string) {
	return openaiModelCatalog[modelId]?.capabilities.language?.reasoning.support;
}

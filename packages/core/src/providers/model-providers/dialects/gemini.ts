import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ProviderDialect } from "./dialect.ts";
import { openaiCompatible } from "./openai-compatible.ts";

/**
 * Lists models through Gemini's OpenAI-compatible API (the preset's base URL),
 * but sends requests to the native API one level up. The compatible API's
 * stream leaves `index` off tool calls, which the OpenAI SDK rejects, and the
 * OpenAI SDK drops the thought signatures Gemini needs back after each tool
 * call.
 */
export const gemini: ProviderDialect = {
	...openaiCompatible,
	name: "Gemini",
	requestRoot: (baseUrl) => baseUrl.replace(/\/openai$/, ""),
	// The native API reports context overflow in its own words.
	recognizeFailure: ({ message }) =>
		/input token count .* exceeds the maximum/i.test(message ?? "")
			? "context-too-long"
			: undefined,
	// Listed ids look like `models/gemma-3-27b-it`. The SDK only recognises
	// Gemma (which doesn't support system instructions) from the bare id.
	languageModel: (endpoint, modelId, fetch) =>
		createGoogleGenerativeAI({
			apiKey: endpoint.apiKey ?? "",
			baseURL: endpoint.baseUrl,
			headers: endpoint.headers,
			fetch,
		})(modelId.replace(/^models\//, "")),
};

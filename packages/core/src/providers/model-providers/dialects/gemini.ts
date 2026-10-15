import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ProviderDialect } from "./dialect.ts";
import { openaiCompatible } from "./openai-compatible.ts";

/** Google's native API, under which its OpenAI-compatible one sits at `/openai`. */
const nativeRoot = (baseUrl: string) => baseUrl.replace(/\/openai\/?$/, "");

/**
 * Gemini lists its models through its OpenAI-compatible API, the preset's
 * address. Requests go to the native API that one sits under: the compatible
 * API streams a tool call in a form OpenAI's SDK can't read, and only the
 * native one hands back the thought signature each tool call must return
 * with the next step.
 */
export const gemini: ProviderDialect = {
	...openaiCompatible,
	name: "Gemini",
	languageModel: (endpoint, modelId, http) => {
		const root = nativeRoot(endpoint.baseUrl);
		return createGoogleGenerativeAI({
			apiKey: endpoint.apiKey ?? "",
			baseURL: root,
			headers: endpoint.headers,
			fetch: http(root),
		})(modelId);
	},
};

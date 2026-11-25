import type { ProviderDialect } from "./dialect.ts";
import { openaiClient, openaiCompatible } from "./openai-compatible.ts";

/**
 * OpenAI uses Responses when thinking options require summaries and encrypted
 * replay. Other requests use its Chat Completions API.
 */
export const openai: ProviderDialect = {
	...openaiCompatible,
	languageModel: (endpoint, modelId, fetch, thinkingOptions) => {
		const client = openaiClient(endpoint, fetch);
		return thinkingOptions?.openai ? client.responses(modelId) : client.chat(modelId);
	},
};

import { type ProviderDialectId, providerBuiltIn } from "@sugabots/contracts";
import { anthropic } from "./anthropic.ts";
import { chatgpt } from "./chatgpt.ts";
import type { ProviderDialect, ProviderIdentity } from "./dialect.ts";
import { gemini } from "./gemini.ts";
import { ollama } from "./ollama.ts";
import { openaiCompatible } from "./openai-compatible.ts";
import { openrouter } from "./openrouter.ts";

export type { DiscoveredModel, ProviderDialect, ProviderIdentity } from "./dialect.ts";
export { type ModelRegistry, modelsDev } from "./registry.ts";
export { anthropic, chatgpt, gemini, ollama, openaiCompatible, openrouter };

/** The code behind each name a built-in provider may give. */
const dialects: Record<ProviderDialectId, ProviderDialect> = {
	"openai-compatible": openaiCompatible,
	anthropic,
	openrouter,
	ollama,
	chatgpt,
	gemini,
};

/**
 * The dialect a provider is read in.
 *
 * A provider made from a built-in provider speaks the dialect its built-in provider names. A custom
 * endpoint is known by its wire format, and by its host where a well-known
 * gateway sits behind an OpenAI-compatible URL; anything else is taken to be
 * plain OpenAI-compatible.
 */
export function dialectFor(provider: ProviderIdentity): ProviderDialect {
	if (provider.builtIn) return dialects[providerBuiltIn(provider.builtIn).dialect];
	if (provider.apiFormat === "anthropic") return anthropic;
	if (new URL(provider.baseUrl).hostname === "openrouter.ai") return openrouter;
	return openaiCompatible;
}

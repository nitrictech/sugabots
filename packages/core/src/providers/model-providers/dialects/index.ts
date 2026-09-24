import { type ProviderDialectId, providerPreset } from "@sugabots/contracts";
import { anthropic } from "./anthropic.ts";
import type { ProviderDialect, ProviderIdentity } from "./dialect.ts";
import { ollama } from "./ollama.ts";
import { openaiCompatible } from "./openai-compatible.ts";
import { openrouter } from "./openrouter.ts";

export type { DiscoveredModel, ProviderDialect, ProviderIdentity } from "./dialect.ts";
export { emptyRegistry, type ModelPrice, type ModelRegistry, modelsDev } from "./registry.ts";
export { anthropic, ollama, openaiCompatible, openrouter };

/** The code behind each name a preset may give. */
export const dialects: Record<ProviderDialectId, ProviderDialect> = {
	"openai-compatible": openaiCompatible,
	anthropic,
	openrouter,
	ollama,
};

/**
 * The dialect a provider is read in.
 *
 * A provider made from a preset speaks the dialect its preset names. A custom
 * endpoint is known by its wire format, and by its host where a well-known
 * gateway sits behind an OpenAI-compatible URL; anything else is taken to be
 * plain OpenAI-compatible.
 */
export function dialectFor(provider: ProviderIdentity): ProviderDialect {
	if (provider.preset) return dialects[providerPreset(provider.preset).dialect];
	if (provider.apiFormat === "anthropic") return anthropic;
	if (new URL(provider.baseUrl).hostname === "openrouter.ai") return openrouter;
	return openaiCompatible;
}

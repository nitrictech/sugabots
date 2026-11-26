import type { BuiltInProviderId } from "@sugabots/contracts";

/**
 * Who makes a model, by the name a provider that resells many puts before
 * its slash (OpenRouter's `maker/model`), where it isn't the maker's name
 * with a capital.
 */
export const MODEL_MAKER_NAMES: Readonly<Record<string, string>> = {
	openai: "OpenAI",
	"meta-llama": "Meta",
	mistralai: "Mistral",
	deepseek: "DeepSeek",
	"x-ai": "xAI",
	moonshotai: "Moonshot",
	qwen: "Qwen",
};

/** The provider whose logo is a maker's, by the name a reseller puts before its slash. */
const MAKER_LOGOS: Readonly<Record<string, BuiltInProviderId>> = {
	anthropic: "anthropic",
	openai: "openai",
	google: "gemini",
	"x-ai": "xai",
	mistralai: "mistral",
	deepseek: "deepseek",
};

/** The providers that make the models they serve, so their own logo is their models' maker's. */
const MAKERS: ReadonlySet<BuiltInProviderId> = new Set<BuiltInProviderId>([
	"anthropic",
	"openai",
	"chatgpt",
	"gemini",
	"xai",
	"supergrok",
	"mistral",
	"deepseek",
]);

/** The logo of who made `model`, where there is one: a reseller's model by its maker, else its provider's. */
export function makerLogoOf(model: {
	modelId: string;
	providerBuiltIn: BuiltInProviderId | null;
}): BuiltInProviderId | undefined {
	const slash = model.modelId.indexOf("/");
	if (slash > 0) return MAKER_LOGOS[model.modelId.slice(0, slash)];
	return model.providerBuiltIn !== null && MAKERS.has(model.providerBuiltIn)
		? model.providerBuiltIn
		: undefined;
}

/**
 * A model's name parted from the maker a reseller writes before it, as
 * OpenRouter writes "Anthropic: Claude Haiku 5.5"; `maker` is absent where
 * the name has none.
 */
export function partMaker(name: string): { maker?: string; name: string } {
	const prefixed = /^([^:]{1,40}):\s+(.+)$/.exec(name);
	return prefixed?.[1] && prefixed[2] ? { maker: prefixed[1], name: prefixed[2] } : { name };
}

import type { Modality } from "@opencode-ai/models";
import { providers } from "@opencode-ai/models/snapshot";
import type { ProviderModelCapability, ProviderPresetId } from "@sugabots/contracts";
import type { DiscoveredModel, ProviderIdentity } from "./dialect.ts";

/**
 * What is known about a model whose provider does not say.
 *
 * OpenAI's listing names its models and nothing more, and Anthropic's adds
 * only a display name, so a workspace connecting either would see every model
 * as capable of nothing. The registry answers from models.dev, the database
 * OpenCode reads, through the snapshot its package ships: the API never calls
 * out for it, and a dependency bump is what brings in new models. A provider
 * that does report something about a model is always believed over it.
 *
 * Not the catalog: that is our list of presets, this is models.dev's list of
 * models.
 */

/** The part of models.dev the registry reads; the package's `ProviderMap` is one. */
export type RegistrySource = Record<
	string,
	{
		api?: string;
		models: Record<
			string,
			{
				name?: string;
				tool_call?: boolean;
				reasoning?: boolean;
				modalities?: { input?: readonly Modality[]; output?: readonly Modality[] };
				limit?: { context?: number };
			}
		>;
	}
>;

type RegistryModel = RegistrySource[string]["models"][string];

export interface ModelRegistry {
	/** The model with what the provider left blank filled in from the registry. */
	complete(model: DiscoveredModel, provider: ProviderIdentity): DiscoveredModel;
}

/**
 * models.dev's id for each preset that it lists, where the two differ or the
 * registry gives no address to match on. Anything else is matched by host.
 */
const MODELS_DEV_PROVIDER: Partial<Record<ProviderPresetId, string>> = {
	anthropic: "anthropic",
	openai: "openai",
	openrouter: "openrouter",
	gemini: "google",
	groq: "groq",
	xai: "xai",
	mistral: "mistral",
	deepseek: "deepseek",
	together: "togetherai",
	fireworks: "fireworks-ai",
	cerebras: "cerebras",
	lmstudio: "lmstudio",
};

/**
 * Whose entry to believe when many providers list the same bare model id.
 * The vendor first, then the gateways that curate; anything else alphabetically.
 */
const PREFERRED_PROVIDERS = ["openai", "anthropic", "google", "openrouter"];

const preference = (providerId: string) => {
	const index = PREFERRED_PROVIDERS.indexOf(providerId);
	return index === -1 ? PREFERRED_PROVIDERS.length : index;
};

/** The last path segment: a gateway lists a vendor's model as `openai/gpt-4o`. */
const bare = (modelId: string) => modelId.slice(modelId.lastIndexOf("/") + 1);

export function registryFrom(source: RegistrySource): ModelRegistry {
	const providerByHost = new Map<string, string>();
	const byBareId = new Map<string, { providerId: string; model: RegistryModel }>();
	for (const [providerId, provider] of Object.entries(source)) {
		const host = provider.api ? URL.parse(provider.api)?.hostname : undefined;
		if (host && !providerByHost.has(host)) providerByHost.set(host, providerId);
		for (const [modelId, model] of Object.entries(provider.models)) {
			const id = bare(modelId);
			const current = byBareId.get(id);
			if (
				!current ||
				preference(providerId) < preference(current.providerId) ||
				(preference(providerId) === preference(current.providerId) &&
					providerId < current.providerId)
			) {
				byBareId.set(id, { providerId, model });
			}
		}
	}

	const lookup = (modelId: string, provider: ProviderIdentity): RegistryModel | undefined => {
		const providerId =
			(provider.preset && MODELS_DEV_PROVIDER[provider.preset]) ??
			providerByHost.get(new URL(provider.baseUrl).hostname);
		const own = providerId ? source[providerId]?.models[modelId] : undefined;
		return own ?? byBareId.get(bare(modelId))?.model;
	};

	return {
		complete(model, provider) {
			const known = lookup(model.modelId, provider);
			if (!known) return model;
			const context = known.limit?.context ?? 0;
			return {
				modelId: model.modelId,
				displayName: model.displayName ?? known.name ?? null,
				capabilities:
					model.capabilities.length > 0 ? model.capabilities : capabilitiesOf(model.modelId, known),
				contextLength: model.contextLength ?? (context > 0 ? context : null),
			};
		},
	};
}

/**
 * The registry has no word for an embedding model, but every one it lists is
 * named for it, and the picker relies on the capability to leave them out.
 */
function capabilitiesOf(modelId: string, known: RegistryModel): ProviderModelCapability[] {
	const capabilities: ProviderModelCapability[] = [];
	const input = known.modalities?.input ?? [];
	const output = known.modalities?.output ?? [];
	if (known.tool_call) capabilities.push("tools");
	if (known.reasoning) capabilities.push("reasoning");
	if (input.includes("image")) capabilities.push("vision");
	if (input.includes("audio")) capabilities.push("audio");
	if (output.includes("image")) capabilities.push("images");
	if (/embed/.test(bare(modelId))) capabilities.push("embeddings");
	return capabilities;
}

/** Fills nothing in, for a test about something else. */
export const emptyRegistry: ModelRegistry = { complete: (model) => model };

/** The registry over the models.dev snapshot shipped with the installed package. */
export const modelsDev: ModelRegistry = registryFrom(providers);

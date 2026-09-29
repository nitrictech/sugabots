import {
	estimateCost,
	openRouterReportedCost,
	ratesFromModelsDev,
	Usd,
	usageFromAiSdk,
} from "@sugabots/accounting";
import { providerPreset } from "@sugabots/contracts";
import type { LanguageModelUsage } from "ai";
import type {
	ModelRegistry,
	ProviderIdentity,
} from "../providers/model-providers/dialects/index.ts";
import type { ModelRequests } from "./model-requests.ts";

const FREE = Usd.make(0);

/**
 * What one completed request cost, or `undefined` when that can't be said.
 *
 * A server the workspace runs itself costs nothing, and neither does a
 * request covered by a flat subscription. Otherwise the provider's own figure
 * is believed where it gives one, and the request is priced from the
 * registry where it doesn't.
 */
export function requestCost(
	provider: ProviderIdentity,
	model: string,
	usage: LanguageModelUsage,
	registry: Pick<ModelRegistry, "cost" | "version">,
): ModelRequests.Cost | undefined {
	const preset = provider.preset ? providerPreset(provider.preset) : undefined;
	if (preset?.hosting === "local") return { usd: FREE, source: "local" };
	if (preset?.credential === "sign-in") return { usd: FREE, source: "subscription" };

	const reported = preset?.id === "openrouter" ? openRouterReportedCost(usage) : undefined;
	if (reported !== undefined) return { usd: reported, source: "provider-reported" };

	const published = registry.cost(model, provider);
	if (!published) return undefined;
	const estimate = estimateCost(usageFromAiSdk(usage), ratesFromModelsDev(published));
	return estimate._tag === "Priced" ? { usd: estimate.usd, source: registry.version } : undefined;
}

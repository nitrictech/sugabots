import {
	estimateCost,
	openRouterReportedCost,
	ratesFromModelsDev,
	Usd,
	usageFromAiSdk,
} from "@sugabots/accounting";
import { providerBuiltIn } from "@sugabots/contracts";
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
 * request a subscription sign-in made, which its flat plan covers; one the
 * same provider made with a key is paid for. Otherwise the provider's own
 * figure is believed where it gives one, and the request is priced from the
 * registry where it doesn't.
 */
export function requestCost(
	provider: ProviderIdentity & { readonly signedIn: boolean },
	model: string,
	usage: LanguageModelUsage,
	registry: Pick<ModelRegistry, "cost" | "version">,
): ModelRequests.Cost | undefined {
	const builtIn = provider.builtIn ? providerBuiltIn(provider.builtIn) : undefined;
	if (builtIn?.hosting === "local") return { usd: FREE, source: "local" };
	if (provider.signedIn) return { usd: FREE, source: "subscription" };

	const reported = builtIn?.id === "openrouter" ? openRouterReportedCost(usage) : undefined;
	if (reported !== undefined) return { usd: reported, source: "provider-reported" };

	const published = registry.cost(model, provider);
	if (!published) return undefined;
	const estimate = estimateCost(usageFromAiSdk(usage), ratesFromModelsDev(published));
	return estimate._tag === "Priced" ? { usd: estimate.usd, source: registry.version } : undefined;
}

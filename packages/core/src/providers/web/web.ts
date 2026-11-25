export * as Web from "./web.ts";

import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { WebToolOff } from "@sugabots/contracts/errors/web";
import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import type { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { workspace } from "../../database/schema.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { CanUseWeb } from "../../proofs/can-use-web.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { searchSettingsPath } from "../../server-settings/web-app-paths.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Egress } from "../network/egress.ts";
import { providerSearch, searchEndpoint } from "../search-providers/provider-search.ts";
import { SearchProviderStore } from "../search-providers/search-provider-store.ts";
import { pageFetcher, WEB_FETCH_LIMITS } from "./fetch-page.ts";

export interface Interface {
	readonly fetch: <P, W, X>(
		canFetch: CanUseWeb<P, W, typeof WEB_FETCH_TOOL>,
		input: InputOf<"web.fetch">,
		approved: Approved<P, X, [W], "web.fetch">,
	) => Effect.Effect<OutputOf<"web.fetch">, WebToolOff>;
	readonly search: <P, W, X>(
		canSearch: CanUseWeb<P, W, typeof WEB_SEARCH_TOOL>,
		input: InputOf<"web.search">,
		approved: Approved<P, X, [W], "web.search">,
	) => Effect.Effect<OutputOf<"web.search">, WebToolOff | ResourceHidden>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Web") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Web");
	const egress = yield* Egress.Service;
	const providers = yield* SearchProviderStore.Service;
	const { webAppUrl } = yield* ServerSettings.Service;
	const fetchPage = pageFetcher({ fetch: egress.webFetch, ...WEB_FETCH_LIMITS });
	const enabledProvider = (workspaceId: string) =>
		Effect.filterOrFail(
			providers.resolve(workspaceId),
			(provider) => provider !== undefined,
			() => new WebToolOff(),
		);
	return Service.of({
		fetch: (canFetch, { url }) =>
			operation(
				"fetch",
				Effect.gen(function* () {
					yield* enabledProvider(canFetch.inWorkspace.workspace.value);
					// biome-ignore lint/plugin: fetchPage returns network and page errors as outcomes.
					return yield* Effect.promise((signal) => fetchPage(url, signal));
				}),
			),

		search: (canSearch, input) =>
			operation(
				"search",
				Effect.gen(function* () {
					const workspaceId = canSearch.inWorkspace.workspace.value;
					const provider = yield* enabledProvider(workspaceId);
					const search = providerSearch(
						provider,
						egress.providers.for({ baseUrl: searchEndpoint(provider) }),
					);
					const outcome = yield* search(input);
					if (outcome.ok) return outcome;

					const [settings] = yield* query((db) =>
						db
							.select({ slug: workspace.slug })
							.from(workspace)
							.where(eq(workspace.id, workspaceId))
							.limit(1),
					);
					if (!settings) return yield* new ResourceHidden({ resource: "workspace" });
					return {
						...outcome,
						settingsPageUrl: `${webAppUrl}${searchSettingsPath(settings.slug)}`,
					};
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(SearchProviderStore.layer));

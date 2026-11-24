export * as BuiltInTools from "./built-in.ts";

import { userText } from "@sugabots/errors";
import type { ToolSet } from "ai";
import { Context, Effect, Layer } from "effect";
import { type Database, effectRunner } from "../../database/database.ts";
import { Egress, type EgressHttpClients } from "../../providers/network/egress.ts";
import {
	providerSearch,
	searchEndpoint,
} from "../../providers/search-providers/provider-search.ts";
import { SearchProviderStore } from "../../providers/search-providers/search-provider-store.ts";
import { type FetchPage, pageFetcher, WEB_FETCH_LIMITS } from "./web-fetch/fetch-page.ts";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch/tool.ts";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search/tool.ts";

/**
 * The built-in tools offered to the turns of a workspace's bots.
 *
 * forWorkspace returns `web_fetch` and `web_search`, usable only while
 * `searchProviders.resolve` finds an enabled search provider with every
 * setting a search needs. The provider's enabled flag
 * is the workspace's one setting for whether bots may use the web, and each
 * search counts towards the workspace's usage. forWorkspace looks the provider
 * up on every call, so a provider enabled between turns applies from the next
 * turn without a restart. A failed search points at `searchSettingsPageUrl`.
 */
export interface Interface {
	forWorkspace(
		workspaceId: string,
		searchSettingsPageUrl: string,
	): Effect.Effect<Offered, never, Database>;
}

export interface Offered {
	tools: ToolSet;
	/** Calls to tools not named here are refused. */
	usable: readonly string[];
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BuiltInTools") {}

/**
 * The tools over the server's egress: a page is fetched under its web
 * policy, and a search goes to the workspace's own provider, with its client
 * bound to that address like a model provider's.
 */
export const make = Effect.gen(function* () {
	const egress = yield* Egress.Service;
	return from({
		fetchPage: pageFetcher({ fetch: egress.webFetch, ...WEB_FETCH_LIMITS }),
		searchProviders: yield* SearchProviderStore.Service,
		httpClients: egress.providers,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(SearchProviderStore.layer));

export interface Parts {
	fetchPage: FetchPage;
	searchProviders: Pick<SearchProviderStore.Interface, "resolve">;
	/** Bound egress clients, so a search goes only to the provider's own address. */
	httpClients: EgressHttpClients;
}

/** The tools built from `parts`, for `make` and for a case that supplies its own. */
export function from({ fetchPage, searchProviders, httpClients }: Parts): Interface {
	const webFetch = webFetchTool({ fetchPage });
	return {
		forWorkspace: (workspaceId, searchSettingsPageUrl) =>
			Effect.gen(function* (): Effect.fn.Return<Offered, never, Database> {
				const provider = yield* searchProviders.resolve(workspaceId);
				if (!provider) {
					return {
						tools: {
							[WEB_FETCH_TOOL]: webFetch,
							[WEB_SEARCH_TOOL]: webSearchTool({
								search: async () => ({ ok: false, reason: NO_SEARCH_PROVIDER }),
								settingsPageUrl: searchSettingsPageUrl,
							}),
						},
						usable: [],
					};
				}
				// The tool runs searches as promises; they log through the turn's services.
				const run = effectRunner<never>({
					runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<never>()),
				});
				const search = providerSearch(
					provider,
					httpClients.for({ baseUrl: searchEndpoint(provider) }),
				);
				return {
					tools: {
						[WEB_FETCH_TOOL]: webFetch,
						[WEB_SEARCH_TOOL]: webSearchTool({
							search: (request) => run(search(request), { signal: request.signal }),
							settingsPageUrl: searchSettingsPageUrl,
						}),
					},
					usable: [WEB_FETCH_TOOL, WEB_SEARCH_TOOL],
				};
			}),
	};
}

const NO_SEARCH_PROVIDER = userText`The workspace has no search provider switched on.`;

/** No built-in tools at all, for a case that offers a turn none. */
export const none: Interface = { forWorkspace: () => Effect.succeed({ tools: {}, usable: [] }) };

export * as BuiltInTools from "./built-in.ts";

import type { ToolSet } from "ai";
import { Context, Effect, Layer } from "effect";
import type { Database } from "../../database/database.ts";
import { Egress, type EgressHttpClients } from "../../providers/network/egress.ts";
import { searchBackend, searchEndpoint } from "../../providers/search-providers/backends.ts";
import { SearchProviderRepository } from "../../providers/search-providers/search-provider-repository.ts";
import { type FetchPage, pageFetcher } from "./web-fetch/fetch-page.ts";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch/tool.ts";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search/tool.ts";

/**
 * The built-in tools offered to a workspace's crew turns.
 *
 * forWorkspace returns `web_fetch` and `web_search` while
 * `searchProviders.resolve` finds an enabled search provider with every
 * setting a search needs, and no tools otherwise. The provider's enabled flag
 * is the workspace's one setting for whether bots may use the web, and each
 * search is billed to the workspace. forWorkspace looks the provider
 * up on every call, so a provider enabled between turns applies from the next
 * turn without a restart.
 */
export interface Interface {
	forWorkspace(workspaceId: string): Effect.Effect<ToolSet, never, Database>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BuiltInTools") {}

/**
 * The tools over the installation's egress: a page is fetched under its web
 * policy, and a search goes to the workspace's own provider, with its client
 * bound to that address like a model provider's.
 */
export const make = Effect.gen(function* () {
	const egress = yield* Egress.Service;
	return from({
		fetchPage: pageFetcher({ fetch: egress.webFetch }),
		searchProviders: yield* SearchProviderRepository.Service,
		httpClients: egress.providers,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(SearchProviderRepository.layer));

export interface Parts {
	fetchPage: FetchPage;
	searchProviders: Pick<SearchProviderRepository.Interface, "resolve">;
	/** Bound egress clients, so a search goes only to the provider's own address. */
	httpClients: EgressHttpClients;
}

/** The tools built from `parts`, for `make` and for a case that supplies its own. */
export function from({ fetchPage, searchProviders, httpClients }: Parts): Interface {
	const webFetch = webFetchTool({ fetchPage });
	return {
		forWorkspace: (workspaceId) =>
			Effect.gen(function* (): Effect.fn.Return<ToolSet, never, Database> {
				const connection = yield* searchProviders.resolve(workspaceId);
				if (!connection) return {};
				// The tool runs searches as promises; they log through the turn's services.
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				const search = searchBackend(
					connection,
					httpClients.for({ baseUrl: searchEndpoint(connection) }),
				);
				return {
					[WEB_FETCH_TOOL]: webFetch,
					[WEB_SEARCH_TOOL]: webSearchTool({ search: (request) => runPromise(search(request)) }),
				};
			}),
	};
}

/** No built-in tools at all, for a case that offers a turn none. */
export const none: Interface = { forWorkspace: () => Effect.succeed({}) };

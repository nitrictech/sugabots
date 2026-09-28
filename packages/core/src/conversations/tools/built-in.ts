import type { ToolSet } from "ai";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { EgressHttpClients } from "../../providers/network/egress.ts";
import { searchBackend, searchEndpoint } from "../../providers/search-providers/backends.ts";
import type { SearchProviderRepository } from "../../providers/search-providers/search-provider-repository.ts";
import type { FetchPage } from "./web-fetch/fetch-page.ts";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch/tool.ts";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search/tool.ts";

/**
 * BuiltInTools supplies the built-in tools offered to a workspace's crew turns.
 *
 * forWorkspace returns `web_fetch` and `web_search` while
 * `searchProviders.resolve` finds an enabled search provider with every
 * setting a search needs, and no tools otherwise. The provider's enabled flag
 * is the workspace's one setting for whether bots may use the web, and each
 * search is billed to the workspace (ADR 005). forWorkspace looks the provider
 * up on every call, so a provider enabled between turns applies from the next
 * turn without a restart.
 */
export interface BuiltInTools {
	forWorkspace(workspaceId: string): Effect.Effect<ToolSet, never, Database>;
}

export interface BuiltInToolsOptions {
	fetchPage: FetchPage;
	searchProviders: Pick<SearchProviderRepository.Interface, "resolve">;
	/** Bound egress clients, so a search goes only to the provider's own address. */
	httpClients: EgressHttpClients;
}

export function builtInTools({
	fetchPage,
	searchProviders,
	httpClients,
}: BuiltInToolsOptions): BuiltInTools {
	const webFetch = webFetchTool({ fetchPage });
	return {
		forWorkspace: (workspaceId) =>
			Effect.map(searchProviders.resolve(workspaceId), (connection): ToolSet => {
				if (!connection) return {};
				return {
					[WEB_FETCH_TOOL]: webFetch,
					[WEB_SEARCH_TOOL]: webSearchTool({
						search: searchBackend(
							connection,
							httpClients.for({ baseUrl: searchEndpoint(connection) }),
						),
					}),
				};
			}),
	};
}

/** No built-in tools at all, for a case that offers a turn none. */
export const noBuiltInTools: BuiltInTools = { forWorkspace: () => Effect.succeed({}) };

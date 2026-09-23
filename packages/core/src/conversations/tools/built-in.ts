import type { ToolSet } from "ai";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import type { EgressHttpClients } from "../../providers/network/egress.ts";
import type { SearchProviderStore } from "../../providers/search-providers/store.ts";
import type { FetchPage } from "./web-fetch/fetch-page.ts";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch/tool.ts";
import { searchBackend, searchEndpoint } from "./web-search/backends.ts";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search/tool.ts";

/**
 * The built-in tools a workspace's crew turns are offered.
 *
 * `web_fetch` costs nothing and is always there. `web_search` is there while
 * the workspace has an enabled search provider with what it needs to be
 * called, since each search is a call the workspace pays for (ADR 005). Asked
 * per turn, so enabling a provider reaches the next turn without a restart.
 */
export interface BuiltInTools {
	forWorkspace(workspaceId: string): Effect.Effect<ToolSet, never, Database>;
}

export interface BuiltInToolsOptions {
	fetchPage: FetchPage;
	searchProviders: Pick<SearchProviderStore, "resolve">;
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
			Effect.map(searchProviders.resolve(workspaceId), (connection) => ({
				[WEB_FETCH_TOOL]: webFetch,
				...(connection
					? {
							[WEB_SEARCH_TOOL]: webSearchTool({
								search: searchBackend(
									connection,
									httpClients.for({ baseUrl: searchEndpoint(connection) }),
								),
							}),
						}
					: {}),
			})),
	};
}

/** No built-in tools at all, for a worker that has not been given any. */
export const noBuiltInTools: BuiltInTools = { forWorkspace: () => Effect.succeed({}) };

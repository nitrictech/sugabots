export * as SearchProviders from "./search-providers.ts";

import type {
	NewSearchProvider,
	SearchProvider,
	SearchProviderTestResult,
	SearchProviderUpdate,
} from "@sugabots/contracts";
import { searchBuiltInProvider } from "@sugabots/contracts";
import {
	type SearchProviderApiKeyRequired,
	SearchProviderNotFound,
	type UrlNotAllowed,
} from "@sugabots/contracts/errors/providers";
import { userText } from "@sugabots/errors";
import { Context, Effect, Layer } from "effect";
import { serviceOperations } from "../../database/database.ts";
import type { CanManageWorkspace, CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, timedTest } from "../tested-configuration.ts";
import { providerSearch, searchEndpoint } from "./provider-search.ts";
import { searchProviderOf, toSearchProvider } from "./search-provider-reads.ts";
import { SearchProviderStore } from "./search-provider-store.ts";

/**
 * Where a workspace's `web_search` goes, for operations that have proved what
 * each call needs: checking an address against the egress policy before it
 * is stored, and trying the service with a query. Each method takes the
 * workspace from its proof. Configuring the provider takes
 * `CanManageWorkspace`; asking whether the web tools are on takes only
 * `CanReadWorkspace`.
 */
export interface Interface {
	/** The workspace's provider, or nothing when it has none. */
	readonly get: <P, W>(
		canManage: CanManageWorkspace<P, W>,
	) => Effect.Effect<SearchProvider | undefined>;
	/** Whether the workspace's bots are offered the web tools. */
	readonly webAccess: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<boolean>;
	/** Sets the workspace's provider, replacing whatever it had, as added by the member whose role gave `canManage`. */
	readonly replace: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		provider: NewSearchProvider,
	) => Effect.Effect<SearchProvider, UrlNotAllowed | SearchProviderApiKeyRequired>;
	readonly update: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		changes: SearchProviderUpdate,
	) => Effect.Effect<
		SearchProvider,
		SearchProviderNotFound | UrlNotAllowed | SearchProviderApiKeyRequired
	>;
	readonly remove: <P, W>(
		canManage: CanManageWorkspace<P, W>,
	) => Effect.Effect<void, SearchProviderNotFound>;
	/** Sends a query, and records what came back against the configuration that sent it. */
	readonly test: <P, W>(
		canManage: CanManageWorkspace<P, W>,
	) => Effect.Effect<SearchProviderTestResult, SearchProviderNotFound>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SearchProviders",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SearchProviders");
	const providers = yield* SearchProviderStore.Service;
	const egress = yield* Egress.Service;

	const requireProvider = (workspaceId: string) =>
		Effect.filterOrFail(
			searchProviderOf(workspaceId),
			(provider) => provider !== undefined,
			() => new SearchProviderNotFound(),
		);

	return Service.of({
		get: (canManage) => operation("get", searchProviderOf(canManage.inWorkspace.workspace.value)),

		webAccess: (canRead) =>
			operation(
				"webAccess",
				Effect.map(
					providers.resolve(canRead.inWorkspace.workspace.value),
					(access) => access !== undefined,
				),
			),

		replace: (canManage, provider) =>
			operation(
				"replace",
				Effect.gen(function* () {
					yield* requireAllowedUrl(
						egress,
						provider.baseUrl ?? searchBuiltInProvider(provider.builtIn).baseUrl,
					);
					const replaced = yield* providers.replace(canManage.inWorkspace.workspace.value, {
						createdById: canManage.actor.memberId,
						provider,
					});
					return toSearchProvider(replaced);
				}),
			),

		update: (canManage, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					if (changes.baseUrl) {
						yield* requireAllowedUrl(egress, changes.baseUrl);
					}
					const updated = yield* providers.update(canManage.inWorkspace.workspace.value, changes);
					if (!updated) {
						return yield* new SearchProviderNotFound();
					}
					return toSearchProvider(updated);
				}),
			),

		remove: (canManage) =>
			operation(
				"remove",
				Effect.gen(function* () {
					if (!(yield* providers.remove(canManage.inWorkspace.workspace.value))) {
						return yield* new SearchProviderNotFound();
					}
				}),
			),

		test: (canManage) =>
			operation(
				"test",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* requireProvider(workspaceId);
					const access = yield* providers.access(workspaceId);
					if (!access) {
						return {
							reachable: false,
							latencyMs: 0,
							error: userText`Add an API key before testing`,
						};
					}
					const tested = yield* timedTest(
						providerSearch(
							access,
							egress.providers.for({ baseUrl: searchEndpoint(access) }),
						)({ query: TEST_QUERY, count: 3 }).pipe(
							Effect.map((outcome) =>
								outcome.ok ? { results: outcome.results.length } : { error: outcome.reason },
							),
						),
					);
					yield* providers.recordTest(workspaceId, access.configurationUpdatedAt, tested.error);
					return tested;
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(SearchProviderStore.layer));

const TEST_QUERY = "Sugabots";

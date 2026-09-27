export * as SearchProviderSetup from "./search-provider-setup.ts";

import type {
	NewSearchProvider,
	SearchProvider,
	SearchProviderTestResult,
	SearchProviderUpdate,
} from "@sugabots/contracts";
import { searchProviderPreset } from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { searchBackend, searchEndpoint } from "./backends.ts";
import { searchProviderOf, toSearchProvider } from "./search-provider-reads.ts";
import { SearchProviderRepository } from "./search-provider-repository.ts";

/**
 * Choosing where a workspace's `web_search` goes: checking an address against
 * the egress policy before it is stored, and trying the service with a query.
 */
export interface Interface {
	/** The workspace's provider, or nothing when it has none. */
	readonly get: (workspaceId: string) => Effect.Effect<SearchProvider | undefined>;
	/** Whether the workspace's bots are offered the web tools. */
	readonly webAccess: (workspaceId: string) => Effect.Effect<boolean>;
	readonly replace: (input: {
		workspaceId: string;
		createdById: string;
		provider: NewSearchProvider;
	}) => Effect.Effect<
		SearchProvider,
		UrlNotAllowed | SearchProviderRepository.SearchProviderApiKeyRequired
	>;
	readonly update: (input: {
		workspaceId: string;
		changes: SearchProviderUpdate;
	}) => Effect.Effect<
		SearchProvider,
		SearchProviderNotFound | UrlNotAllowed | SearchProviderRepository.SearchProviderApiKeyRequired
	>;
	readonly remove: (workspaceId: string) => Effect.Effect<void, SearchProviderNotFound>;
	/** Sends a query, and records what came back against the configuration that sent it. */
	readonly test: (
		workspaceId: string,
	) => Effect.Effect<SearchProviderTestResult, SearchProviderNotFound>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SearchProviderSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SearchProviderSetup");
	const providers = yield* SearchProviderRepository.Service;
	const egress = yield* Egress.Service;

	const requireProvider = (workspaceId: string) =>
		Effect.filterOrFail(
			searchProviderOf(workspaceId),
			(provider) => provider !== undefined,
			() => new SearchProviderNotFound(),
		);

	return Service.of({
		get: (workspaceId) => operation("get", searchProviderOf(workspaceId)),

		webAccess: (workspaceId) =>
			operation(
				"webAccess",
				Effect.map(providers.resolve(workspaceId), (connection) => connection !== undefined),
			),

		replace: ({ workspaceId, createdById, provider }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					yield* requireAllowedUrl(
						egress,
						provider.baseUrl ?? searchProviderPreset(provider.preset).baseUrl,
					);
					return toSearchProvider(yield* providers.replace(workspaceId, { createdById, provider }));
				}),
			),

		update: ({ workspaceId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					if (changes.baseUrl) {
						yield* requireAllowedUrl(egress, changes.baseUrl);
					}
					const updated = yield* providers.update(workspaceId, changes);
					if (!updated) {
						return yield* new SearchProviderNotFound();
					}
					return toSearchProvider(updated);
				}),
			),

		remove: (workspaceId) =>
			operation(
				"remove",
				Effect.filterOrFail(
					providers.remove(workspaceId),
					(removed) => removed,
					() => new SearchProviderNotFound(),
				).pipe(Effect.asVoid),
			),

		test: (workspaceId) =>
			operation(
				"test",
				Effect.gen(function* () {
					yield* requireProvider(workspaceId);
					const connection = yield* providers.connection(workspaceId);
					if (!connection) {
						return {
							reachable: false,
							latencyMs: 0,
							error: UserMessage.of`Add an API key before testing`,
						};
					}
					const started = yield* Clock.currentTimeMillis;
					const outcome = yield* Effect.promise(() =>
						searchBackend(
							connection,
							egress.providers.for({ baseUrl: searchEndpoint(connection) }),
						)({ query: TEST_QUERY, count: 3 }),
					);
					const latencyMs = (yield* Clock.currentTimeMillis) - started;
					const error = outcome.ok ? undefined : outcome.reason;
					yield* providers.recordTest(workspaceId, connection.configurationUpdatedAt, error);
					return {
						reachable: outcome.ok,
						latencyMs,
						...(outcome.ok ? { results: outcome.results.length } : { error }),
					};
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(SearchProviderRepository.layer));

export class SearchProviderNotFound
	extends Data.TaggedError("SearchProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This workspace has no search provider`;
	}
}

const TEST_QUERY = "Sugabots agents";

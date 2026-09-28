import type {
	NewSearchProvider,
	SearchProviderTestResult,
	SearchProviderUpdate,
} from "@sugabots/contracts";
import { searchProviderPreset } from "@sugabots/contracts";
import { Data, Effect } from "effect";
import { searchBackend, searchEndpoint } from "../../conversations/tools/web-search/backends.ts";
import type { Database } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import type { EgressHttpClients, EgressUrlValidator } from "../network/egress.ts";
import type { SearchProviderStore } from "./store.ts";

export class SearchProviderNotFound
	extends Data.TaggedError("SearchProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This workspace has no search provider`;
	}
}

export class SearchProviderUrlNotAllowed
	extends Data.TaggedError("SearchProviderUrlNotAllowed")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Search provider URL is not allowed by the network policy`;
	}
}

export class SearchProviderApiKeyRequired
	extends Data.TaggedError("SearchProviderApiKeyRequired")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Add an API key before enabling search`;
	}
}

const TEST_QUERY = "Sugabots agents";

export function searchProviderOperations({
	providers,
	httpClients,
	validateProviderUrl,
}: {
	providers: SearchProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
}) {
	const requireProvider = (workspaceId: string) =>
		Effect.filterOrFail(
			providers.get(workspaceId),
			(provider) => provider != null,
			() => new SearchProviderNotFound(),
		);

	const requireAllowedUrl = (baseUrl: string) =>
		Effect.tryPromise({
			try: () => validateProviderUrl(baseUrl),
			catch: () => new SearchProviderUrlNotAllowed(),
		});

	return {
		get: (workspaceId: string) =>
			Effect.map(providers.get(workspaceId), (provider) => ({ provider: provider ?? null })),

		webAccess: (workspaceId: string) =>
			Effect.map(providers.resolve(workspaceId), (connection) => ({
				enabled: connection !== undefined,
			})),

		replace: (workspaceId: string, userId: string, input: NewSearchProvider) =>
			Effect.andThen(
				requireAllowedUrl(input.baseUrl ?? searchProviderPreset(input.preset).baseUrl),
				() => providers.replace(workspaceId, userId, input),
			),

		update: (workspaceId: string, input: SearchProviderUpdate) =>
			Effect.gen(function* () {
				const current = yield* requireProvider(workspaceId);
				if (input.baseUrl) {
					yield* requireAllowedUrl(input.baseUrl);
				}
				const keyAfter = input.apiKey === undefined ? current.hasApiKey : input.apiKey !== null;
				if (input.enabled && searchProviderPreset(current.preset).requiresApiKey && !keyAfter) {
					return yield* new SearchProviderApiKeyRequired();
				}
				const updated = yield* providers.update(workspaceId, input);
				return updated ?? (yield* requireProvider(workspaceId));
			}),

		remove: (workspaceId: string) =>
			Effect.filterOrFail(
				providers.remove(workspaceId),
				(removed) => removed,
				() => new SearchProviderNotFound(),
			).pipe(Effect.asVoid),

		test: (
			workspaceId: string,
		): Effect.Effect<SearchProviderTestResult, SearchProviderNotFound, Database> =>
			Effect.gen(function* () {
				yield* requireProvider(workspaceId);
				const connection = yield* providers.connection(workspaceId);
				if (!connection) {
					return { reachable: false, latencyMs: 0, error: "Add an API key before testing" };
				}
				const started = Date.now();
				const outcome = yield* Effect.promise(() =>
					searchBackend(
						connection,
						httpClients.for({ baseUrl: searchEndpoint(connection) }),
					)({ query: TEST_QUERY, count: 3 }),
				);
				const error = outcome.ok ? undefined : outcome.reason;
				yield* providers.recordTest(workspaceId, connection.configurationUpdatedAt, error);
				return {
					reachable: outcome.ok,
					latencyMs: Date.now() - started,
					...(outcome.ok ? { results: outcome.results.length } : { error }),
				};
			}),
	};
}

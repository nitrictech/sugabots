export * as SearchProviderStore from "./search-provider-store.ts";

import type { NewSearchProvider, SearchProviderUpdate } from "@sugabots/contracts";
import { DEFAULT_SEARCH_BUILT_IN, searchBuiltInProvider } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { type SearchProviderRow, searchProvider } from "../../database/schema.ts";
import { Secrets } from "../../secrets/secrets.ts";
import type { UserFacing } from "../../user-message.ts";
import { changesAddress, stillConfiguredAs } from "../tested-configuration.ts";
import type { SearchProviderAccess } from "./search-provider-access.ts";
import { searchProviderRowOf } from "./search-provider-reads.ts";

/**
 * The only writer of `search_provider`: a workspace's one search provider.
 *
 * Search is never on while the provider's built-in provider needs a key it lacks:
 * switching it on without one is refused, and taking the key away switches
 * it off. A new address takes the stored key away, unless a key comes with it.
 */
export interface Interface {
	/**
	 * Gives a new workspace the default provider, switched on, so `web_search`
	 * works before anyone opens settings. Uses Exa's free tier, which needs no
	 * key.
	 */
	readonly provisionDefault: (workspaceId: string, createdById: string) => Effect.Effect<void>;
	/** Sets the workspace's provider, replacing whatever it had. */
	readonly replace: (
		workspaceId: string,
		input: { createdById: string; provider: NewSearchProvider },
	) => Effect.Effect<SearchProviderRow, SearchProviderApiKeyRequired>;
	readonly update: (
		workspaceId: string,
		changes: SearchProviderUpdate,
	) => Effect.Effect<SearchProviderRow | undefined, SearchProviderApiKeyRequired>;
	readonly remove: (workspaceId: string) => Effect.Effect<boolean>;
	/**
	 * Records how a test of the configuration last updated at `testedAt` went,
	 * `error` saying why it failed, unless the provider has been reconfigured
	 * since.
	 */
	readonly recordTest: (
		workspaceId: string,
		testedAt: Date,
		error?: UserText,
	) => Effect.Effect<void>;
	/** How to search, enabled or not, for a test; nothing while a required key is missing. */
	readonly access: (workspaceId: string) => Effect.Effect<SearchProviderAccess | undefined>;
	/** {@link Interface.access} only while search is enabled, for a turn. */
	readonly resolve: (workspaceId: string) => Effect.Effect<SearchProviderAccess | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SearchProviderStore",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SearchProviderStore");
	const cipher = yield* Secrets.Service;

	/** The provider access, or nothing when the built-in provider needs a key the row lacks. */
	const toAccess = (row: SearchProviderRow): SearchProviderAccess | undefined => {
		if (searchBuiltInProvider(row.builtIn).requiresApiKey && !row.apiKeyEncrypted) {
			return undefined;
		}
		return {
			builtIn: row.builtIn,
			baseUrl: row.baseUrl,
			apiKey: row.apiKeyEncrypted ? cipher.decrypt(row.apiKeyEncrypted) : undefined,
			configurationUpdatedAt: row.updatedAt,
		};
	};

	return Service.of({
		provisionDefault: (workspaceId, createdById) =>
			operation(
				"provisionDefault",
				query((db) =>
					db
						.insert(searchProvider)
						.values({
							workspaceId,
							builtIn: DEFAULT_SEARCH_BUILT_IN,
							baseUrl: searchBuiltInProvider(DEFAULT_SEARCH_BUILT_IN).baseUrl,
							enabled: true,
							createdById,
						})
						.onConflictDoNothing({ target: searchProvider.workspaceId }),
				).pipe(Effect.asVoid),
			),

		replace: (workspaceId, { createdById, provider }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const enabled = provider.enabled ?? false;
					if (
						enabled &&
						searchBuiltInProvider(provider.builtIn).requiresApiKey &&
						!provider.apiKey
					) {
						return yield* new SearchProviderApiKeyRequired();
					}
					const values = {
						builtIn: provider.builtIn,
						baseUrl: provider.baseUrl ?? searchBuiltInProvider(provider.builtIn).baseUrl,
						apiKeyEncrypted: provider.apiKey ? cipher.encrypt(provider.apiKey) : null,
						enabled,
						lastTestedAt: null,
						lastTestError: null,
					};
					const [row] = yield* query((db) =>
						db
							.insert(searchProvider)
							.values({ workspaceId, createdById, ...values })
							.onConflictDoUpdate({
								target: searchProvider.workspaceId,
								set: { ...values, createdById },
							})
							.returning(),
					);
					if (!row) {
						return yield* Effect.die(new Error("Search provider upsert returned no row"));
					}
					return row;
				}),
			),

		update: (workspaceId, changes) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const [current] = yield* query((db) =>
							db
								.select({
									builtIn: searchProvider.builtIn,
									baseUrl: searchProvider.baseUrl,
									apiKeyEncrypted: searchProvider.apiKeyEncrypted,
								})
								.from(searchProvider)
								.where(eq(searchProvider.workspaceId, workspaceId))
								.for("update"),
						);
						if (!current) return undefined;
						const dropsKey =
							changes.apiKey === undefined && changesAddress(changes.baseUrl, current.baseUrl);
						const needsKey = searchBuiltInProvider(current.builtIn).requiresApiKey;
						const hasKey =
							changes.apiKey === undefined
								? current.apiKeyEncrypted !== null && !dropsKey
								: changes.apiKey !== null;
						if (changes.enabled === true && needsKey && !hasKey) {
							return yield* new SearchProviderApiKeyRequired();
						}
						const configurationChanged =
							changes.baseUrl !== undefined || changes.apiKey !== undefined;
						const [row] = yield* query((db) =>
							db
								.update(searchProvider)
								.set({
									enabled: needsKey && !hasKey ? false : changes.enabled,
									baseUrl: changes.baseUrl,
									apiKeyEncrypted: changes.apiKey
										? cipher.encrypt(changes.apiKey)
										: changes.apiKey === null || dropsKey
											? null
											: undefined,
									lastTestedAt: configurationChanged ? null : undefined,
									lastTestError: configurationChanged ? null : undefined,
								})
								.where(eq(searchProvider.workspaceId, workspaceId))
								.returning(),
						);
						return row;
					}),
				),
			),

		remove: (workspaceId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(searchProvider)
						.where(eq(searchProvider.workspaceId, workspaceId))
						.returning({ id: searchProvider.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		recordTest: (workspaceId, testedAt, error) =>
			operation(
				"recordTest",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(searchProvider)
							.set({ lastTestedAt: now, lastTestError: error ?? null })
							.where(
								and(
									eq(searchProvider.workspaceId, workspaceId),
									stillConfiguredAs(searchProvider.updatedAt, testedAt),
								),
							),
					);
				}),
			),

		access: (workspaceId) =>
			operation(
				"access",
				Effect.map(searchProviderRowOf(workspaceId), (row) => (row ? toAccess(row) : undefined)),
			),

		resolve: (workspaceId) =>
			operation(
				"resolve",
				Effect.map(searchProviderRowOf(workspaceId), (row) =>
					row?.enabled ? toAccess(row) : undefined,
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** Search was to be switched on for a built-in provider that needs a key, without one. */
export class SearchProviderApiKeyRequired
	extends Data.TaggedError("SearchProviderApiKeyRequired")
	implements UserFacing
{
	get userMessage() {
		return userText`Add an API key before enabling search`;
	}
}

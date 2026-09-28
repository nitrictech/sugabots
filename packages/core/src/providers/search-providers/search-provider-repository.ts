export * as SearchProviderRepository from "./search-provider-repository.ts";

import type { NewSearchProvider, SearchProviderUpdate } from "@sugabots/contracts";
import { DEFAULT_SEARCH_PRESET, searchProviderPreset } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { type SearchProviderRow, searchProvider } from "../../database/schema.ts";
import { Ids } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { stillConfiguredAs } from "../tested-configuration.ts";
import type { SearchConnection } from "./search-connection.ts";

/**
 * The only writer of `search_provider`: a workspace's one search provider.
 *
 * Search is never on while the provider's preset needs a key it lacks:
 * switching it on without one is refused, and taking the key away switches
 * it off.
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
		error?: UserMessage,
	) => Effect.Effect<void>;
	/** How to search, enabled or not, for a test; nothing while a required key is missing. */
	readonly connection: (workspaceId: string) => Effect.Effect<SearchConnection | undefined>;
	/** {@link Interface.connection} only while search is enabled, for a turn. */
	readonly resolve: (workspaceId: string) => Effect.Effect<SearchConnection | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SearchProviderRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SearchProviderRepository");
	const ids = yield* Ids.Service;
	const cipher = yield* Credentials.Service;

	const load = (workspaceId: string) =>
		query((db) =>
			db.select().from(searchProvider).where(eq(searchProvider.workspaceId, workspaceId)).limit(1),
		).pipe(Effect.map(([row]) => row));

	/** The connection, or nothing when the preset needs a key the row lacks. */
	const toConnection = (row: SearchProviderRow): SearchConnection | undefined => {
		if (searchProviderPreset(row.preset).requiresApiKey && !row.apiKeyEncrypted) {
			return undefined;
		}
		return {
			preset: row.preset,
			baseUrl: row.baseUrl,
			apiKey: row.apiKeyEncrypted ? cipher.decrypt(row.apiKeyEncrypted) : undefined,
			configurationUpdatedAt: row.updatedAt,
		};
	};

	return Service.of({
		provisionDefault: (workspaceId, createdById) =>
			operation(
				"provisionDefault",
				Effect.gen(function* () {
					const id = yield* ids.next;
					yield* query((db) =>
						db
							.insert(searchProvider)
							.values({
								id,
								workspaceId,
								preset: DEFAULT_SEARCH_PRESET,
								baseUrl: searchProviderPreset(DEFAULT_SEARCH_PRESET).baseUrl,
								enabled: true,
								createdById,
							})
							.onConflictDoNothing({ target: searchProvider.workspaceId }),
					);
				}),
			),

		replace: (workspaceId, { createdById, provider }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const enabled = provider.enabled ?? false;
					if (enabled && searchProviderPreset(provider.preset).requiresApiKey && !provider.apiKey) {
						return yield* new SearchProviderApiKeyRequired();
					}
					const values = {
						preset: provider.preset,
						baseUrl: provider.baseUrl ?? searchProviderPreset(provider.preset).baseUrl,
						apiKeyEncrypted: provider.apiKey ? cipher.encrypt(provider.apiKey) : null,
						enabled,
						lastTestedAt: null,
						lastTestError: null,
					};
					const id = yield* ids.next;
					const [row] = yield* query((db) =>
						db
							.insert(searchProvider)
							.values({ id, workspaceId, createdById, ...values })
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
									preset: searchProvider.preset,
									apiKeyEncrypted: searchProvider.apiKeyEncrypted,
								})
								.from(searchProvider)
								.where(eq(searchProvider.workspaceId, workspaceId))
								.for("update"),
						);
						if (!current) return undefined;
						const needsKey = searchProviderPreset(current.preset).requiresApiKey;
						const hasKey =
							changes.apiKey === undefined
								? current.apiKeyEncrypted !== null
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
									apiKeyEncrypted:
										changes.apiKey === undefined
											? undefined
											: changes.apiKey === null
												? null
												: cipher.encrypt(changes.apiKey),
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

		connection: (workspaceId) =>
			operation(
				"connection",
				Effect.map(load(workspaceId), (row) => (row ? toConnection(row) : undefined)),
			),

		resolve: (workspaceId) =>
			operation(
				"resolve",
				Effect.map(load(workspaceId), (row) => (row?.enabled ? toConnection(row) : undefined)),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** Search was to be switched on for a preset that needs a key, without one. */
export class SearchProviderApiKeyRequired
	extends Data.TaggedError("SearchProviderApiKeyRequired")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Add an API key before enabling search`;
	}
}

import type {
	NewSearchProvider,
	SearchProvider,
	SearchProviderPresetId,
	SearchProviderUpdate,
} from "@sugabots/contracts";
import { DEFAULT_SEARCH_PRESET, searchProviderPreset } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, type Executor, query } from "../../database/database.ts";
import { type SearchProviderRow, searchProvider } from "../../database/schema.ts";
import type { CredentialCipher } from "../model-providers/credentials.ts";

/** What the `web_search` backend needs to call the workspace's search service. */
export interface SearchConnection {
	preset: SearchProviderPresetId;
	baseUrl: string;
	apiKey?: string;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
}

/**
 * Reading and writing a workspace's one search provider.
 *
 * Nothing here declares a failure: a workspace has one provider or none, and
 * every method answers with a value. `resolve` is what a turn asks: the
 * connection, only while the provider is enabled and, where its preset needs
 * one, has a key. `connection` is what a test asks: the same without the
 * enabled check, since a test is how an admin finds out whether to enable it.
 */
export interface SearchProviderStore {
	get(workspaceId: string): Effect.Effect<SearchProvider | undefined, never, Database>;
	/** Sets the workspace's provider, replacing whatever it had. */
	replace(
		workspaceId: string,
		userId: string,
		input: NewSearchProvider,
	): Effect.Effect<SearchProvider, never, Database>;
	update(
		workspaceId: string,
		input: SearchProviderUpdate,
	): Effect.Effect<SearchProvider | undefined, never, Database>;
	remove(workspaceId: string): Effect.Effect<boolean, never, Database>;
	connection(workspaceId: string): Effect.Effect<SearchConnection | undefined, never, Database>;
	resolve(workspaceId: string): Effect.Effect<SearchConnection | undefined, never, Database>;
	recordTest(
		workspaceId: string,
		configurationUpdatedAt: Date,
		error?: string,
	): Effect.Effect<void, never, Database>;
}

export function searchProviderStore(cipher: CredentialCipher): SearchProviderStore {
	const load = (workspaceId: string) =>
		query((db) =>
			db
				.select()
				.from(searchProvider)
				.where(eq(searchProvider.workspaceId, workspaceId))
				.limit(1)
				.pipe(Effect.map(([row]) => row)),
		);

	const connection: SearchProviderStore["connection"] = (workspaceId) =>
		Effect.map(load(workspaceId), (row) => (row ? toConnection(row, cipher) : undefined));

	return {
		get: (workspaceId) => Effect.map(load(workspaceId), (row) => row && toSearchProvider(row)),

		replace: (workspaceId, userId, input) =>
			Effect.gen(function* () {
				const values = {
					preset: input.preset,
					baseUrl: input.baseUrl ?? searchProviderPreset(input.preset).baseUrl,
					apiKeyEncrypted: input.apiKey ? cipher.encrypt(input.apiKey) : null,
					enabled: input.enabled ?? false,
					lastTestedAt: null,
					lastTestError: null,
				};
				const [row] = yield* query((db) =>
					db
						.insert(searchProvider)
						.values({ workspaceId, createdById: userId, ...values })
						.onConflictDoUpdate({
							target: searchProvider.workspaceId,
							set: { ...values, createdById: userId },
						})
						.returning(),
				);
				if (!row) {
					return yield* Effect.die(new Error("Search provider upsert returned no row"));
				}
				return toSearchProvider(row);
			}),

		update: (workspaceId, input) =>
			Effect.gen(function* () {
				const connectionChanged = input.baseUrl !== undefined || input.apiKey !== undefined;
				const [row] = yield* query((db) =>
					db
						.update(searchProvider)
						.set({
							enabled: input.enabled,
							baseUrl: input.baseUrl,
							apiKeyEncrypted:
								input.apiKey === undefined
									? undefined
									: input.apiKey === null
										? null
										: cipher.encrypt(input.apiKey),
							lastTestedAt: connectionChanged ? null : undefined,
							lastTestError: connectionChanged ? null : undefined,
						})
						.where(eq(searchProvider.workspaceId, workspaceId))
						.returning(),
				);
				return row && toSearchProvider(row);
			}),

		remove: (workspaceId) =>
			Effect.map(
				query((db) =>
					db
						.delete(searchProvider)
						.where(eq(searchProvider.workspaceId, workspaceId))
						.returning({ id: searchProvider.id }),
				),
				(rows) => rows.length > 0,
			),

		connection,

		resolve: (workspaceId) =>
			Effect.map(load(workspaceId), (row) =>
				row?.enabled ? toConnection(row, cipher) : undefined,
			),

		recordTest: (workspaceId, configurationUpdatedAt, error) =>
			Effect.asVoid(
				query((db) =>
					db
						.update(searchProvider)
						.set({ lastTestedAt: new Date(), lastTestError: error ?? null })
						.where(
							and(
								eq(searchProvider.workspaceId, workspaceId),
								// The row keeps microseconds when Postgres stamped it; the Date
								// we were handed back keeps milliseconds. Compare at the coarser one.
								sql`date_trunc('milliseconds', ${searchProvider.updatedAt}) = ${configurationUpdatedAt}`,
							),
						),
				),
			),
	};
}

/**
 * Gives a new workspace the default provider, switched on, so `web_search`
 * works before anyone opens settings. Uses Exa's free tier by default.
 */
export const provisionDefaultSearchProvider = Effect.fn(
	"SearchProviderStore.provisionDefaultSearchProvider",
)(function* (db: Executor, workspaceId: string, userId: string) {
	yield* db
		.insert(searchProvider)
		.values({
			workspaceId,
			preset: DEFAULT_SEARCH_PRESET,
			baseUrl: searchProviderPreset(DEFAULT_SEARCH_PRESET).baseUrl,
			enabled: true,
			createdById: userId,
		})
		.onConflictDoNothing({ target: searchProvider.workspaceId });
});

/** The connection, or nothing when the preset needs a key the row lacks. */
function toConnection(
	row: SearchProviderRow,
	cipher: CredentialCipher,
): SearchConnection | undefined {
	if (searchProviderPreset(row.preset).requiresApiKey && !row.apiKeyEncrypted) {
		return undefined;
	}
	return {
		preset: row.preset,
		baseUrl: row.baseUrl,
		apiKey: row.apiKeyEncrypted ? cipher.decrypt(row.apiKeyEncrypted) : undefined,
		configurationUpdatedAt: row.updatedAt,
	};
}

function toSearchProvider(row: SearchProviderRow): SearchProvider {
	const preset = searchProviderPreset(row.preset);
	const hasApiKey = row.apiKeyEncrypted !== null;
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: preset.name,
		baseUrl: row.baseUrl,
		enabled: row.enabled,
		status:
			preset.requiresApiKey && !hasApiKey
				? "missing_key"
				: row.lastTestedAt === null
					? "untested"
					: row.lastTestError
						? "error"
						: "connected",
		hasApiKey,
		// A stored key is never shown again; the hint is that one exists.
		apiKeyHint: hasApiKey ? "" : null,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}

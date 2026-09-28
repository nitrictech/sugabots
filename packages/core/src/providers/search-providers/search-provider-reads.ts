import type { SearchProvider } from "@sugabots/contracts";
import { searchProviderPreset } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { type SearchProviderRow, searchProvider } from "../../database/schema.ts";
import { apiKeyHint, configurationStatus } from "../tested-configuration.ts";

/** The workspace's search provider, or nothing when it has none. */
export const searchProviderOf = (workspaceId: string) =>
	query((db) =>
		db.select().from(searchProvider).where(eq(searchProvider.workspaceId, workspaceId)).limit(1),
	).pipe(Effect.map(([row]) => row && toSearchProvider(row)));

export function toSearchProvider(row: SearchProviderRow): SearchProvider {
	const preset = searchProviderPreset(row.preset);
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: preset.name,
		baseUrl: row.baseUrl,
		enabled: row.enabled,
		status: configurationStatus({
			missingKey: preset.requiresApiKey && row.apiKeyEncrypted === null,
			lastTestedAt: row.lastTestedAt,
			lastTestError: row.lastTestError,
		}),
		hasApiKey: row.apiKeyEncrypted !== null,
		apiKeyHint: apiKeyHint(row.apiKeyEncrypted),
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}

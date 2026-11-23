import type { SearchProvider } from "@sugabots/contracts";
import { searchBuiltInProvider } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { type SearchProviderRow, searchProvider } from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";

/** The workspace's search provider, or nothing when it has none. */
export const searchProviderOf = (workspaceId: string) =>
	query((db) =>
		db.select().from(searchProvider).where(eq(searchProvider.workspaceId, workspaceId)).limit(1),
	).pipe(Effect.map(([row]) => row && toSearchProvider(row)));

export function toSearchProvider(row: SearchProviderRow): SearchProvider {
	const builtIn = searchBuiltInProvider(row.builtIn);
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		builtIn: row.builtIn,
		name: builtIn.name,
		baseUrl: row.baseUrl,
		enabled: row.enabled,
		status: configurationStatus({
			missingKey: builtIn.requiresApiKey && row.apiKeyEncrypted === null,
			lastTestedAt: row.lastTestedAt,
			lastTestError: row.lastTestError,
		}),
		hasApiKey: row.apiKeyEncrypted !== null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}

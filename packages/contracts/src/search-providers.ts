import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Search providers: where a workspace's `web_search` tool sends its queries.
 *
 * Search costs money per query, so the workspace that wants it configures and
 * pays for it. One provider per workspace, made from a preset the
 * way a model provider is, with the workspace's own key. `web_search` is
 * offered to an agent only while the provider is enabled and, where the
 * preset needs one, has a key.
 */

export const searchProviderPresetIdSchema = Schema.Literals(["brave", "exa", "tavily", "searxng"]);
export type SearchProviderPresetId = typeof searchProviderPresetIdSchema.Type;

/** The provider a workspace has until it chooses another. */
export const DEFAULT_SEARCH_PRESET: SearchProviderPresetId = "exa";

/**
 * Where Exa answers without a key: its free MCP endpoint, rate limited. With
 * a key, Exa is called at its API address like any other provider.
 */
export const EXA_FREE_SEARCH_URL = "https://mcp.exa.ai/mcp";

/** One entry in the search catalog: data about a search service we know how to call. */
export interface SearchProviderPreset {
	id: SearchProviderPresetId;
	name: string;
	baseUrl: string;
	/** A remote preset has a fixed address and wants a key; a local one is a server you run. */
	hosting: "remote" | "local";
	requiresApiKey: boolean;
}

export const searchProviderCatalog: readonly SearchProviderPreset[] = [
	{
		id: "exa",
		name: "Exa",
		baseUrl: "https://api.exa.ai",
		hosting: "remote",
		requiresApiKey: false,
	},
	{
		id: "brave",
		name: "Brave Search",
		baseUrl: "https://api.search.brave.com/res/v1",
		hosting: "remote",
		requiresApiKey: true,
	},
	{
		id: "tavily",
		name: "Tavily",
		baseUrl: "https://api.tavily.com",
		hosting: "remote",
		requiresApiKey: true,
	},
	{
		id: "searxng",
		name: "SearXNG",
		baseUrl: "http://127.0.0.1:8080",
		hosting: "local",
		requiresApiKey: false,
	},
];

export function searchProviderPreset(id: SearchProviderPresetId): SearchProviderPreset {
	const preset = searchProviderCatalog.find((candidate) => candidate.id === id);
	if (!preset) {
		throw new Error(`Unknown search provider preset: ${id}`);
	}
	return preset;
}

export const searchProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	preset: searchProviderPresetIdSchema,
	name: Schema.String,
	baseUrl: providerUrlSchema,
	/** Whether agents in this workspace are offered `web_search`. */
	enabled: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type SearchProvider = typeof searchProviderSchema.Type;

const apiKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

/** A workspace's search provider, set or replaced: the preset supplies everything but the key. */
export const newSearchProviderSchema = Schema.Struct({
	preset: searchProviderPresetIdSchema,
	/** Switched on as it is set, so one call can turn the default on. */
	enabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(apiKeySchema),
	/** Only a local preset's address is worth changing. */
	baseUrl: Schema.optional(providerUrlSchema),
});

export type NewSearchProvider = typeof newSearchProviderSchema.Type;

export const searchProviderUpdateSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	baseUrl: Schema.optional(providerUrlSchema),
	/** Absent leaves the stored key alone; null removes it. */
	apiKey: Schema.optional(Schema.NullOr(apiKeySchema)),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type SearchProviderUpdate = typeof searchProviderUpdateSchema.Type;

/** What `GET` answers: the provider, or null when the workspace has none. */
export const searchProviderResponseSchema = Schema.Struct({
	provider: Schema.NullOr(searchProviderSchema),
});

/**
 * webAccessSchema describes whether a workspace's bots are offered the web
 * tools, `web_fetch` and `web_search`. `enabled` is true while the workspace
 * has an enabled search provider with every setting a search needs, such as
 * an API key for a provider that requires one.
 */
export const webAccessSchema = Schema.Struct({ enabled: Schema.Boolean });
export type WebAccess = typeof webAccessSchema.Type;

export const searchProviderTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** How many results the test query returned, when it was reachable. */
	results: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	error: Schema.optional(Schema.String),
});

export type SearchProviderTestResult = typeof searchProviderTestResultSchema.Type;

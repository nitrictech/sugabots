import { createAnthropic } from "@ai-sdk/anthropic";
import { Effect, Schema, SchemaGetter } from "effect";
import {
	dataListing,
	discoveredModel,
	type ProviderDialect,
	type ProviderModelFields,
} from "./dialect.ts";

/**
 * Anthropic keys with a header of its own and pages its listing, twenty models
 * at a time unless asked for more. The listing has no capabilities, so the
 * registry supplies them. Its models cache only the prompt prefixes a
 * request marks.
 */
/** Where Anthropic's API is, under a base URL given with or without its `/v1`. */
const apiRoot = (baseUrl: string) => (baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`);

export const anthropic: ProviderDialect = {
	name: "Anthropic",
	discoveryRoot: apiRoot,
	languageModel: (endpoint, modelId, http) =>
		createAnthropic({
			apiKey: endpoint.apiKey ?? "",
			baseURL: apiRoot(endpoint.baseUrl.replace(/\/$/, "")),
			headers: endpoint.headers,
			fetch: http(endpoint.baseUrl),
		})(modelId),
	listingUrl: (root) => `${root}/models?limit=1000`,
	authorization: (apiKey) => ({ "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }),
	cacheBreakpoint: () => ({ anthropic: { cacheControl: { type: "ephemeral" } } }),
	listing: dataListing,
	model: Schema.Struct({
		id: Schema.String,
		display_name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
	}).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform(
				(entry): ProviderModelFields => ({ modelId: entry.id, displayName: entry.display_name }),
			),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
};

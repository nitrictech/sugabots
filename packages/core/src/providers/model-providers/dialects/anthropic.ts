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
 * registry supplies them.
 */
export const anthropic: ProviderDialect = {
	name: "Anthropic",
	discoveryRoot: (baseUrl) => (baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`),
	listingUrl: (root) => `${root}/models?limit=1000`,
	authorization: (apiKey) => ({ "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }),
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

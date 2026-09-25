import { Effect, Schema, SchemaGetter } from "effect";
import {
	dataListing,
	discoveredModel,
	type ProviderDialect,
	type ProviderModelFields,
} from "./dialect.ts";

/**
 * OpenAI and everything that speaks its API: Groq, vLLM, LM Studio, a gateway.
 * A bare listing carries ids only, so the registry does the rest; a richer
 * one is read for the OpenRouter-style architecture and context fields some
 * servers include.
 */
export const openaiCompatible: ProviderDialect = {
	name: "OpenAI-compatible",
	listingUrl: (root) => `${root}/models`,
	authorization: (apiKey): Record<string, string> =>
		apiKey ? { authorization: `Bearer ${apiKey}` } : {},
	listing: dataListing,
	model: Schema.Struct({
		id: Schema.String,
		display_name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
		name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
		architecture: Schema.Struct({
			modality: Schema.String.pipe(
				Schema.withDecodingDefault(Effect.succeed("")),
				Schema.catchDecoding(() => Effect.succeedSome("")),
			),
		}).pipe(
			Schema.withDecodingDefaultType(Effect.succeed({ modality: "" })),
			Schema.catchDecoding(() => Effect.succeedSome({ modality: "" })),
		),
		context_length: Schema.optional(Schema.Finite).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
	}).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform(
				(entry): ProviderModelFields => ({
					modelId: entry.id,
					displayName: entry.display_name ?? entry.name,
					capabilities: entry.architecture.modality.split("->")[0]?.includes("image")
						? ["vision"]
						: [],
					contextLength: entry.context_length,
				}),
			),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
};

import { createOpenAI } from "@ai-sdk/openai";
import { Effect, Schema, SchemaGetter } from "effect";
import type { EgressHttpClient } from "../../network/egress.ts";
import {
	dataListing,
	discoveredModel,
	type ProviderDialect,
	type ProviderModelFields,
	type RequestEndpoint,
} from "./dialect.ts";

/** The OpenAI SDK, set up for `endpoint` and sending through `fetch`. */
export function openaiClient(endpoint: RequestEndpoint, fetch: EgressHttpClient) {
	return createOpenAI({
		// The SDK requires a key, even for servers that don't use one.
		apiKey: endpoint.apiKey ?? "no-key",
		baseURL: endpoint.baseUrl,
		headers: endpoint.headers,
		fetch,
	});
}

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
	languageModel: (endpoint, modelId, fetch) => openaiClient(endpoint, fetch).chat(modelId),
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

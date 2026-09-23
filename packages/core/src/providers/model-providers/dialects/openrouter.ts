import type { ProviderModelCapability } from "@sugabots/contracts";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import {
	dataListing,
	discoveredModel,
	type ProviderDialect,
	type ProviderModelFields,
} from "./dialect.ts";
import { openaiCompatible } from "./openai-compatible.ts";

const names = Schema.Array(Schema.String).pipe(
	Schema.withDecodingDefault(Effect.succeed([])),
	Schema.catchDecoding(() => Effect.succeed(Option.some([]))),
);

/**
 * OpenRouter's listing says what each model takes in, gives out, and accepts
 * as parameters, so nothing is left to the registry.
 */
export const openrouter: ProviderDialect = {
	name: "OpenRouter",
	listingUrl: (root) => `${root}/models`,
	authorization: openaiCompatible.authorization,
	listing: dataListing,
	model: Schema.Struct({
		id: Schema.String,
		name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
		),
		architecture: Schema.Struct({ input_modalities: names, output_modalities: names }).pipe(
			Schema.withDecodingDefaultType(
				Effect.succeed({ input_modalities: [], output_modalities: [] }),
			),
			Schema.catchDecoding(() =>
				Effect.succeed(Option.some({ input_modalities: [], output_modalities: [] })),
			),
		),
		supported_parameters: names,
		context_length: Schema.optional(Schema.Finite).pipe(
			Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
		),
	}).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform((entry): ProviderModelFields => {
				const { input_modalities: inputs, output_modalities: outputs } = entry.architecture;
				const parameters = entry.supported_parameters;
				const capabilities: ProviderModelCapability[] = [];
				if (parameters.includes("tools")) capabilities.push("tools");
				if (parameters.includes("reasoning")) capabilities.push("reasoning");
				if (inputs.includes("image")) capabilities.push("vision");
				if (inputs.includes("audio")) capabilities.push("audio");
				if (outputs.includes("image")) capabilities.push("images");
				return {
					modelId: entry.id,
					displayName: entry.name,
					capabilities,
					contextLength: entry.context_length,
				};
			}),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
};

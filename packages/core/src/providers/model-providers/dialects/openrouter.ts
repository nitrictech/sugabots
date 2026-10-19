import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ProviderModelCapability } from "@sugabots/contracts";
import { wrapLanguageModel } from "ai";
import { Effect, Schema, SchemaGetter } from "effect";
import { recognizeAnthropicFailure } from "./anthropic.ts";
import {
	dataListing,
	discoveredModel,
	type ProviderDialect,
	type ProviderModelFields,
} from "./dialect.ts";
import { openaiCompatible, recognizeOpenAIFailure } from "./openai-compatible.ts";
import { toolImagesFromUser } from "./tool-images.ts";

const names = Schema.Array(Schema.String).pipe(
	Schema.withDecodingDefault(Effect.succeed([])),
	Schema.catchDecoding(() => Effect.succeedSome([])),
);

/** How OpenRouter's ids for Anthropic's models start, as in `anthropic/claude-sonnet-4.5`. */
const ANTHROPIC_MODELS = "anthropic/";

/**
 * OpenRouter's listing says what each model takes in, gives out, and accepts
 * as parameters, so nothing is left to the registry. Its Anthropic models,
 * like Anthropic's own, cache only the prompt prefixes a request marks;
 * the rest cache by themselves or not at all.
 */
export const openrouter: ProviderDialect = {
	name: "OpenRouter",
	// The public /models endpoint accepts invalid keys; /models/user requires authentication.
	listingUrl: (root) => `${root}/models/user`,
	authorization: openaiCompatible.authorization,
	// OpenRouter serves both OpenAI-style and Anthropic models, so check for either's errors.
	recognizeFailure: (report) => recognizeOpenAIFailure(report) ?? recognizeAnthropicFailure(report),
	languageModel: (endpoint, modelId, fetch) =>
		wrapLanguageModel({
			model: createOpenRouter({
				apiKey: endpoint.apiKey ?? "",
				baseURL: endpoint.baseUrl,
				headers: endpoint.headers,
				fetch,
				// Include usage at the end of each stream; costs are recorded from it.
				compatibility: "strict",
			})(modelId),
			middleware: toolImagesFromUser,
		}),
	cacheBreakpoint: (modelId) =>
		modelId.startsWith(ANTHROPIC_MODELS)
			? { openrouter: { cacheControl: { type: "ephemeral" } } }
			: undefined,
	listing: dataListing,
	model: Schema.Struct({
		id: Schema.String,
		name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
		architecture: Schema.Struct({ input_modalities: names, output_modalities: names }).pipe(
			Schema.withDecodingDefaultType(
				Effect.succeed({ input_modalities: [], output_modalities: [] }),
			),
			Schema.catchDecoding(() =>
				Effect.succeedSome({ input_modalities: [], output_modalities: [] }),
			),
		),
		supported_parameters: names,
		context_length: Schema.optional(Schema.Finite).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
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

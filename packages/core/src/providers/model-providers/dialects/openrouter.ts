import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { projectLinks } from "@sugabots/contracts/project-links";
import { wrapLanguageModel } from "ai";
import { Effect, Schema, SchemaGetter } from "effect";
import { recognizeAnthropicFailure } from "./anthropic.ts";
import {
	capabilitiesFrom,
	dataListing,
	discoveredModel,
	lenientOptional,
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
	// The public /models endpoint accepts invalid keys; /models/user requires authentication.
	listingUrl: (root) => `${root}/models/user`,
	authorization: openaiCompatible.authorization,
	// OpenRouter serves both OpenAI-style and Anthropic models, so check for either's errors.
	recognizeFailure: (report) => recognizeOpenAIFailure(report) ?? recognizeAnthropicFailure(report),
	languageModel: (endpoint, modelId, fetch) =>
		wrapLanguageModel({
			model: createOpenRouter({
				// Tells OpenRouter which app is calling, the same way on every server.
				appName: "Sugabots",
				appUrl: projectLinks.website,
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
		name: lenientOptional(Schema.String),
		architecture: Schema.Struct({ input_modalities: names, output_modalities: names }).pipe(
			Schema.withDecodingDefaultType(
				Effect.succeed({ input_modalities: [], output_modalities: [] }),
			),
			Schema.catchDecoding(() =>
				Effect.succeedSome({ input_modalities: [], output_modalities: [] }),
			),
		),
		supported_parameters: names,
		context_length: lenientOptional(Schema.Finite),
	}).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform((entry): ProviderModelFields => {
				const parameters = entry.supported_parameters;
				return {
					modelId: entry.id,
					displayName: entry.name,
					capabilities: capabilitiesFrom({
						tools: parameters.includes("tools"),
						thinking: parameters.includes("reasoning"),
						inputs: entry.architecture.input_modalities,
						outputs: entry.architecture.output_modalities,
					}),
					contextLength: entry.context_length,
				};
			}),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
};

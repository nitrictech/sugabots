import { Effect, Schema, SchemaGetter } from "effect";
import {
	type CapabilityVocabulary,
	capabilitiesNamed,
	capabilityWords,
	discoveredModel,
	ModelInspectionFailed,
	type ProviderDialect,
	type ProviderModelFields,
} from "./dialect.ts";
import { openaiCompatible } from "./openai-compatible.ts";

const INSPECT_TIMEOUT_MS = 10_000;

const OLLAMA_CAPABILITIES: CapabilityVocabulary = {
	tools: "tools",
	vision: "vision",
	thinking: "reasoning",
};

/** What `/api/show` says about a model, as the two fields the listing lacked. */
const shown = Schema.Struct({
	capabilities: capabilityWords,
	model_info: Schema.Record(Schema.String, Schema.Unknown).pipe(
		Schema.withDecodingDefault(Effect.succeed({})),
		Schema.catchDecoding(() => Effect.succeedSome({})),
	),
});

/**
 * Ollama's OpenAI-compatible listing names its models and no more, but its
 * native API beside it says what each one can do, so discovery steps out of
 * `/v1` to the root the two share and asks about each model in turn.
 */
export const ollama: ProviderDialect = {
	name: "Ollama",
	discoveryRoot: (baseUrl) => baseUrl.replace(/\/v1$/, ""),
	listingUrl: (root) => `${root}/api/tags`,
	authorization: openaiCompatible.authorization,
	listing: Schema.Struct({ models: Schema.mutable(Schema.Array(Schema.Unknown)) }).pipe(
		Schema.decodeTo(Schema.mutable(Schema.Array(Schema.Unknown)), {
			decode: SchemaGetter.transform((body) => body.models),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
	model: Schema.Struct({ name: Schema.String }).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform((entry): ProviderModelFields => ({ modelId: entry.name })),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
	inspect: (root, model, http) =>
		Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					http(`${root}/api/show`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ model: model.modelId }),
						signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS),
					}),
				catch: (cause) =>
					new ModelInspectionFailed({
						message: cause instanceof Error ? cause.message : String(cause),
						cause,
					}),
			});
			if (!response.ok) {
				return yield* new ModelInspectionFailed({
					message: `Ollama returned ${response.status} for ${model.modelId}`,
				});
			}
			const body = yield* Effect.tryPromise({
				try: () => response.json() as Promise<unknown>,
				catch: () =>
					new ModelInspectionFailed({
						message: `Ollama described ${model.modelId} with something that is not JSON`,
					}),
			});
			const details = Schema.decodeUnknownResult(shown)(body);
			if (details._tag === "Failure") return model;
			if (details.success.capabilities.includes("embedding")) return undefined;
			const refined = Schema.decodeUnknownResult(discoveredModel)({
				...model,
				capabilities: capabilitiesNamed(OLLAMA_CAPABILITIES, details.success.capabilities),
				contextLength: Object.entries(details.success.model_info).find(([key]) =>
					key.endsWith(".context_length"),
				)?.[1],
			});
			return refined._tag === "Success" ? refined.success : model;
		}),
};

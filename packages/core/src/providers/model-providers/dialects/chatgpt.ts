import { Effect, Schema, SchemaGetter } from "effect";
import { discoveredModel, type ProviderDialect, type ProviderModelFields } from "./dialect.ts";

/**
 * The Codex backend lists the models a ChatGPT plan may use under `models`,
 * with ones hidden from Codex's own picker among them. It offers each only to
 * clients at least as new as the model, so discovery says it is a recent Codex.
 */
const CODEX_CLIENT_VERSION = "0.157.0";

export const chatgpt: ProviderDialect = {
	name: "ChatGPT",
	listingUrl: (root) => `${root}/models?client_version=${CODEX_CLIENT_VERSION}`,
	authorization: (apiKey): Record<string, string> =>
		apiKey ? { authorization: `Bearer ${apiKey}` } : {},
	listing: Schema.Struct({ models: Schema.mutable(Schema.Array(Schema.Unknown)) }).pipe(
		Schema.decodeTo(Schema.mutable(Schema.Array(Schema.Unknown)), {
			decode: SchemaGetter.transform((body) => body.models.filter(listedInPicker)),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
	model: Schema.Struct({
		slug: Schema.String,
		display_name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
		context_window: Schema.optional(Schema.Finite).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
		// Codex assumes images are accepted when a model does not say.
		input_modalities: Schema.Array(Schema.String).pipe(
			Schema.withDecodingDefault(Effect.succeed(["text", "image"])),
			Schema.catchDecoding(() => Effect.succeedSome(["text", "image"])),
		),
	}).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform(
				(entry): ProviderModelFields => ({
					modelId: entry.slug,
					displayName: entry.display_name,
					// Every model Codex offers is an agent model: it reasons and calls tools.
					capabilities: [
						"tools",
						"reasoning",
						...(entry.input_modalities.includes("image") ? (["vision"] as const) : []),
					],
					contextLength: entry.context_window,
				}),
			),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
};

function listedInPicker(entry: unknown): boolean {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as { visibility?: unknown }).visibility === "list"
	);
}

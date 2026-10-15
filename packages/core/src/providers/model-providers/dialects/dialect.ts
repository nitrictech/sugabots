import {
	newProviderModelSchema,
	type ProviderApiFormat,
	type ProviderModelCapability,
	type ProviderPresetId,
	providerModelCapabilitySchema,
} from "@sugabots/contracts";
import type { LanguageModel, ModelMessage } from "ai";
import { Data, Effect, Schema, SchemaGetter } from "effect";
import type { EgressHttpClient } from "../../network/egress.ts";

/**
 * A provider's variation on the protocol it claims to speak.
 *
 * Most providers speak OpenAI's API or Anthropic's, and each departs from it
 * somewhere: a key sent in a header of its own, a listing that pages, a
 * native API beside the compatible one that says what the listing leaves
 * out. A dialect is that departure written as code, one file beside this one
 * per provider that has one, so a preset can name it and the code that talks
 * to a provider never asks which one it is.
 *
 * A dialect handles discovery (listing a provider's models and reading their
 * details) and requests (which SDK to use, and any provider-specific request
 * options). Headers a provider needs on every request also belong here.
 */

export interface DiscoveredModel {
	modelId: string;
	displayName: string | null;
	capabilities: ProviderModelCapability[];
	contextLength: number | null;
}

/**
 * The part of a provider's connection that says which provider it is: the
 * preset it was made from, or, for a custom endpoint, where it is and what it
 * claims to speak.
 */
export interface ProviderIdentity {
	preset: ProviderPresetId | null;
	baseUrl: string;
	apiFormat: ProviderApiFormat;
}

/** Options for one provider's SDK, keyed by the provider they are for. */
export type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;

/** Base URL, credentials and headers for a provider's requests. */
export interface RequestEndpoint {
	baseUrl: string;
	apiKey?: string;
	headers: Record<string, string>;
}

export interface ProviderDialect {
	/** Named in tests and in what a person is told. */
	readonly name: string;
	/**
	 * The URL discovery is confined to, given the base URL without its
	 * trailing slash; the base URL itself when absent. The HTTP client is
	 * bound here, so a provider whose native API sits beside its
	 * OpenAI-compatible one widens this to the path the two share and no
	 * further.
	 */
	discoveryRoot?(baseUrl: string): string;
	/**
	 * The URL requests are restricted to. Gets the base URL without a trailing
	 * slash; defaults to it. Set this when the provider's request API isn't at
	 * the base URL, as with Gemini's native API one level above its
	 * OpenAI-compatible one.
	 */
	requestRoot?(baseUrl: string): string;
	/** Where the listing is, under the discovery root. */
	listingUrl(root: string): string;
	/** How the provider wants the key presented. */
	authorization(apiKey: string | undefined): Record<string, string>;
	/** The listing's body, read as the entries it carries. */
	readonly listing: Schema.Decoder<unknown[]>;
	/** One entry of the listing, read as the model it describes. */
	readonly model: Schema.Decoder<DiscoveredModel>;
	/**
	 * What the listing left out, asked of the provider about one model. It may
	 * only refine what the listing said: a failure keeps the listed model.
	 */
	inspect?(
		root: string,
		model: DiscoveredModel,
		http: EgressHttpClient,
	): Effect.Effect<DiscoveredModel, ModelInspectionFailed>;
	/**
	 * The options that mark the end of a prompt prefix later requests repeat,
	 * for a model that caches only the prefixes a request marks. Absent, or
	 * undefined for a model, where the provider caches prefixes by itself or
	 * not at all.
	 */
	cacheBreakpoint?(modelId: string): ProviderOptions | undefined;
	/**
	 * Builds the model with the provider's SDK. `endpoint.baseUrl` is the
	 * request root, and `fetch` only allows requests under it.
	 */
	languageModel(endpoint: RequestEndpoint, modelId: string, fetch: EgressHttpClient): LanguageModel;
	/**
	 * For a provider that won't take the system prompt as a message: the
	 * provider options that carry it instead. If unset, it's sent as a system
	 * message.
	 */
	systemOptions?(system: string): ProviderOptions;
}

export class ModelInspectionFailed extends Data.TaggedError("ModelInspectionFailed")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** A listing whose entries sit under `data`: OpenAI's shape, and the one most providers copy. */
export const dataListing = Schema.Struct({
	data: Schema.mutable(Schema.Array(Schema.Unknown)),
}).pipe(
	Schema.decodeTo(Schema.mutable(Schema.Array(Schema.Unknown)), {
		decode: SchemaGetter.transform((body) => body.data),
		encode: SchemaGetter.forbiddenEncoding,
	}),
);

/** What a provider calls each capability, in the word this API uses for it. */
export type CapabilityVocabulary = Record<string, ProviderModelCapability>;

/**
 * A provider's list of capability words, translated through its vocabulary.
 * Words this API has no name for are dropped rather than failing the model,
 * since every provider lists things we do not track: `completion`, `hot`,
 * `rerank`.
 */
export const capabilitiesNamed = (vocabulary: CapabilityVocabulary) =>
	Schema.Array(Schema.String).pipe(
		Schema.withDecodingDefault(Effect.succeed([])),
		Schema.catchDecoding(() => Effect.succeedSome([])),
		Schema.decodeTo(Schema.mutable(Schema.Array(providerModelCapabilitySchema)), {
			decode: SchemaGetter.transform((names) => names.flatMap((name) => vocabulary[name] ?? [])),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	);

/** The fields a dialect reads out of a provider's entry, before the contract has checked them. */
export type ProviderModelFields = typeof newProviderModelSchema.Encoded;

/**
 * What a dialect read from a provider's entry, as the model the contract
 * allows. Each dialect's `model` schema ends by piping into this, so an entry
 * with an unusable id or an out-of-range context length is no model at all.
 */
export const discoveredModel = newProviderModelSchema.pipe(
	Schema.decodeTo(
		Schema.Struct({
			modelId: Schema.mutableKey(Schema.String),
			displayName: Schema.mutableKey(Schema.NullOr(Schema.String)),
			capabilities: Schema.mutableKey(Schema.mutable(Schema.Array(providerModelCapabilitySchema))),
			contextLength: Schema.mutableKey(Schema.NullOr(Schema.Finite)),
		}),
		{
			decode: SchemaGetter.transform(
				(model): DiscoveredModel => ({
					modelId: model.modelId,
					displayName: model.displayName ?? null,
					capabilities: [...new Set(model.capabilities)],
					contextLength: model.contextLength ?? null,
				}),
			),
			encode: SchemaGetter.forbiddenEncoding,
		},
	),
);

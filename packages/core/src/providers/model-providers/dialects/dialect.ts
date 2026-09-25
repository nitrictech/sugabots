import {
	newProviderModelSchema,
	type ProviderApiFormat,
	type ProviderModelCapability,
	type ProviderPresetId,
	providerModelCapabilitySchema,
} from "@sugabots/contracts";
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
 * Discovery, how a provider lists its models and what it says about them, is
 * what a dialect covers so far. A header a provider wants on every request,
 * or an option its completions take, belongs here too as the need arrives.
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

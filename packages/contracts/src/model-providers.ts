import { Effect, Result, Schema } from "effect";
import { modelIdSchema } from "./agents.ts";
import {
	presetRequiresApiKey,
	presetSignsIn,
	providerCatalog,
	providerPresetIdSchema,
} from "./provider-catalog.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const providerApiFormatSchema = Schema.Literals(["openai", "anthropic"]);
export type ProviderApiFormat = typeof providerApiFormatSchema.Type;
export const providerStatusSchema = Schema.Literals([
	"missing_key",
	"signed_out",
	"untested",
	"connected",
	"error",
]);
export type ProviderStatus = typeof providerStatusSchema.Type;
export const providerModelCapabilitySchema = Schema.Literals([
	"tools",
	"vision",
	"images",
	"audio",
	"embeddings",
	"reasoning",
]);
export type ProviderModelCapability = typeof providerModelCapabilitySchema.Type;

/**
 * Headers the HTTP client or the browser owns. No configured header may set
 * one, whatever it is for: the client fills them in itself, and a value from
 * a form would fight it or smuggle a request-shaping header past the policy.
 */
const clientOwnedHeaders = new Set([
	"accept-charset",
	"accept-encoding",
	"access-control-request-headers",
	"access-control-request-method",
	"authentication-info",
	"connection",
	"content-length",
	"cookie",
	"date",
	"dnt",
	"expect",
	"host",
	"keep-alive",
	"origin",
	"permissions-policy",
	"proxy-authenticate",
	"proxy-authentication-info",
	"proxy-authorization",
	"proxy-connection",
	"referer",
	"set-cookie",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"via",
	"www-authenticate",
]);

export function isClientOwnedHeader(name: string): boolean {
	const normalized = name.toLowerCase();
	return (
		clientOwnedHeaders.has(normalized) ||
		normalized.startsWith("proxy-") ||
		normalized.startsWith("sec-")
	);
}

/**
 * The headers a provider's SDK sets from the stored API key. A custom header
 * with the same name would fight it, so a provider may not add one; a
 * connection's secret, which has no SDK behind it, goes in exactly these.
 */
const providerCredentialHeaders = new Set(["authorization", "x-api-key"]);

function isReservedProviderHeader(name: string) {
	return isClientOwnedHeader(name) || providerCredentialHeaders.has(name.toLowerCase());
}

/** A syntactically valid HTTP header name; what may be named is the caller's rule. */
export const headerNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, { message: "Use a valid HTTP header name" }),
);

export const providerHeaderSchema = Schema.Struct({
	name: headerNameSchema.check(
		Schema.makeFilter((name) => !isReservedProviderHeader(name), {
			message: "Header name is reserved",
		}),
	),
	value: Schema.String.check(
		Schema.isMaxLength(2048),
		Schema.makeFilter((value) => !/[\r\n]/.test(value), { message: "Header value is invalid" }),
	),
});

/*
 * The shape of a provider URL, which is all a schema can judge. Whether the API
 * may actually connect to it — HTTPS or plain HTTP, public or private address —
 * is the installation's network policy, which the API applies in one place to
 * every provider alike.
 */
export const providerUrlSchema = Schema.Trim.check(
	Schema.makeFilter((value) => Result.isSuccess(Schema.decodeResult(Schema.URLFromString)(value)), {
		message: "Invalid URL",
	}),
	Schema.makeFilter((value) => /^https?:\/\//i.test(value), { message: "Use an HTTP URL" }),
	Schema.makeFilter(
		(value) =>
			!value
				.slice(value.indexOf("//") + 2)
				.split(/[/?#]/, 1)[0]
				?.includes("@"),
		{ message: "URL credentials are not allowed" },
	),
	Schema.makeFilter((value) => !value.includes("#"), { message: "URL fragments are not allowed" }),
);

const providerHeadersSchema = Schema.mutable(Schema.Array(providerHeaderSchema)).check(
	Schema.isMaxLength(20),
	Schema.makeFilter((headers) => {
		const names = new Set<string>();
		const issues: Schema.FilterIssue[] = [];
		for (const [index, header] of headers.entries()) {
			const name = header.name.toLowerCase();
			if (names.has(name)) {
				issues.push({
					issue: "Header names must be unique",
					path: [index, "name"],
				});
			}
			names.add(name);
		}
		return issues;
	}),
);

/** Each capability as the settings page names and explains it. */
export const providerModelCapabilityCatalog: ReadonlyArray<{
	key: ProviderModelCapability;
	name: string;
	description: string;
}> = [
	{
		key: "tools",
		name: "Tools",
		description: "Can call tools: collaborate, search, fetch a page.",
	},
	{ key: "vision", name: "Vision", description: "Reads images sent to it." },
	{ key: "images", name: "Images", description: "Makes images." },
	{ key: "audio", name: "Audio", description: "Hears or speaks." },
	{ key: "reasoning", name: "Reasoning", description: "Thinks before it answers." },
	{
		key: "embeddings",
		name: "Embeddings",
		description: "Turns text into vectors. Not offered to agents as a chat model.",
	},
];

export const providerModelSchema = Schema.Struct({
	id: uuidSchema,
	modelId: modelIdSchema,
	displayName: Schema.NullOr(Schema.String),
	/** What the provider reports the model can do; for a model added by hand, what the admin said. */
	capabilities: Schema.mutable(Schema.Array(providerModelCapabilitySchema)),
	/**
	 * Of `capabilities`, the ones an admin switched off for agents. The report
	 * is the ceiling: nothing can be switched on that is not in it, only off,
	 * and a refresh brings the report up to date without touching this list.
	 */
	disabledCapabilities: Schema.mutable(Schema.Array(providerModelCapabilitySchema)),
	contextLength: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
	enabled: Schema.Boolean,
	source: Schema.Literals(["fetched", "manual"]),
});

export type ProviderModel = typeof providerModelSchema.Type;

export const modelProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	/** The catalog entry this was made from; null is a custom endpoint. */
	preset: Schema.NullOr(providerPresetIdSchema),
	name: Schema.String,
	baseUrl: providerUrlSchema,
	apiFormat: providerApiFormatSchema,
	active: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	apiKeyHint: Schema.NullOr(Schema.String),
	/** For a provider signed in to rather than given a key (ChatGPT), whether somebody has. */
	signedIn: Schema.Boolean,
	customHeaders: Schema.mutable(
		Schema.Array(Schema.Struct({ name: Schema.String, valueHint: Schema.String })),
	),
	modelCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	enabledModelCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	models: Schema.mutable(Schema.Array(providerModelSchema)),
});

export type ModelProvider = typeof modelProviderSchema.Type;

/** Whether the provider still needs its key, or its sign-in, before it can be used. */
export function providerLacksCredential(
	provider: Pick<ModelProvider, "preset" | "hasApiKey" | "signedIn">,
): boolean {
	if (presetSignsIn(provider.preset)) return !provider.signedIn;
	return presetRequiresApiKey(provider.preset) && !provider.hasApiKey;
}

/**
 * A ChatGPT sign-in waiting on the person: they open `verificationUrl`, enter
 * `userCode`, and the page asks for the outcome with `attempt` every
 * `pollIntervalMs` until it is no longer pending.
 */
export const chatgptSignInStartedSchema = Schema.Struct({
	verificationUrl: Schema.String,
	userCode: Schema.String,
	/** Opaque to the page: the sealed sign-in it hands back when it asks. */
	attempt: Schema.String,
	pollIntervalMs: Schema.Int.check(Schema.isGreaterThan(0)),
	expiresAt: isoTimestampSchema,
});
export type ChatgptSignInStarted = typeof chatgptSignInStartedSchema.Type;

export const chatgptSignInCompletionSchema = Schema.Struct({
	attempt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});

const presetNames = new Set(providerCatalog.map(({ name }) => name.toLowerCase()));
const apiKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

/** A provider from the catalog: the preset supplies everything but the key. */
export const newProviderFromPresetSchema = Schema.Struct({
	preset: providerPresetIdSchema,
	apiKey: Schema.optional(apiKeySchema),
	/** Only a local preset's address is worth changing at creation. */
	baseUrl: Schema.optional(providerUrlSchema),
});

/** A provider the catalog does not know: every field is the caller's. */
export const newCustomProviderSchema = Schema.Struct({
	name: Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(64),
		Schema.makeFilter((name) => !presetNames.has(name.toLowerCase()), {
			message: "That name belongs to a provider in the catalog; add it from there",
		}),
	),
	baseUrl: providerUrlSchema,
	apiFormat: providerApiFormatSchema,
	apiKey: Schema.optional(apiKeySchema),
	customHeaders: providerHeadersSchema.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export const newModelProviderSchema = Schema.Union([
	newProviderFromPresetSchema,
	newCustomProviderSchema,
]);

export type NewProviderFromPreset = typeof newProviderFromPresetSchema.Type;
export type NewCustomProvider = typeof newCustomProviderSchema.Type;
export type NewModelProvider = typeof newModelProviderSchema.Type;

export const modelProviderUpdateSchema = Schema.Struct({
	active: Schema.optional(Schema.Boolean),
	baseUrl: Schema.optional(providerUrlSchema),
	apiFormat: Schema.optional(providerApiFormatSchema),
	/** Absent leaves the stored key alone; null removes it. */
	apiKey: Schema.optional(Schema.NullOr(apiKeySchema)),
	customHeaders: Schema.optional(providerHeadersSchema),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type ModelProviderUpdate = typeof modelProviderUpdateSchema.Type;

export const newProviderModelSchema = Schema.Struct({
	modelId: modelIdSchema,
	displayName: Schema.optional(
		Schema.NullOr(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
	),
	capabilities: Schema.mutable(Schema.Array(providerModelCapabilitySchema)).pipe(
		Schema.withDecodingDefault(Effect.succeed([])),
	),
	contextLength: Schema.optional(
		Schema.NullOr(
			Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10_000_000)),
		),
	),
});

const capabilityListSchema = Schema.mutable(Schema.Array(providerModelCapabilitySchema)).check(
	Schema.isUnique({ message: "Capabilities must be unique" }),
);

export const providerModelUpdateSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	/** The capabilities agents may not use, out of what the model has. */
	disabledCapabilities: Schema.optional(capabilityListSchema),
	/** What the model can do. Only for a model added by hand; the provider says for the rest. */
	capabilities: Schema.optional(capabilityListSchema),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type ProviderModelUpdate = typeof providerModelUpdateSchema.Type;

/** What agents may actually use: the model's capabilities less the ones switched off. */
export function effectiveCapabilities(
	model: Pick<ProviderModel, "capabilities" | "disabledCapabilities">,
): ProviderModelCapability[] {
	return model.capabilities.filter(
		(capability) => !model.disabledCapabilities.includes(capability),
	);
}

export const bulkProviderModelUpdateSchema = Schema.Struct({
	modelIds: Schema.mutable(Schema.Array(uuidSchema)).check(Schema.isMinLength(1)),
	enabled: Schema.Boolean,
});

export const workspaceModelSchema = Schema.Struct({
	providerId: uuidSchema,
	providerName: Schema.String,
	providerPreset: Schema.NullOr(providerPresetIdSchema),
	providerActive: Schema.Boolean,
	modelId: modelIdSchema,
	displayName: Schema.NullOr(Schema.String),
});

export const workspaceModelsResponseSchema = Schema.Struct({
	models: Schema.mutable(Schema.Array(workspaceModelSchema)),
});
export type WorkspaceModelsResponse = typeof workspaceModelsResponseSchema.Type;

export const chatgptSignInOutcomeSchema = Schema.Union([
	Schema.Struct({ status: Schema.Literal("pending") }),
	Schema.Struct({ status: Schema.Literal("signed_in"), provider: modelProviderSchema }),
]);
export type ChatgptSignInOutcome = typeof chatgptSignInOutcomeSchema.Type;

export const providerTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	error: Schema.optional(Schema.String),
});
export const providerFetchResultSchema = Schema.Struct({
	added: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Models already listed whose capabilities, context length or name the provider now reports differently. */
	updated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	unchanged: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

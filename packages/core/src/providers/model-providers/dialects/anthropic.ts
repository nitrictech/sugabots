import { createAnthropic } from "@ai-sdk/anthropic";
import { Effect, Schema, SchemaGetter } from "effect";
import type { RecognizeFailure } from "../../models/request-failures.ts";
import {
	dataListing,
	discoveredModel,
	type ProviderDialect,
	type ProviderModelFields,
} from "./dialect.ts";

/** Anthropic's API is under `/v1`. Accepts a base URL with or without it. */
const apiRoot = (baseUrl: string) => (baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`);

/**
 * Maps Anthropic errors to shared failures:
 * - 400 "credit balance is too low": quota exhausted
 * - "prompt is too long": context too long
 * - 529, or `overloaded_error` sent mid-stream: overloaded
 */
export const recognizeAnthropicFailure: RecognizeFailure = ({ status, code, message }) => {
	if (status === 400 && /credit balance is too low/i.test(message ?? "")) return "quota-exhausted";
	if (/prompt is too long/i.test(message ?? "")) return "context-too-long";
	if (status === 529 || code === "overloaded_error") return "overloaded";
	return undefined;
};

/**
 * Anthropic keys with a header of its own and pages its listing, twenty models
 * at a time unless asked for more. The listing has no capabilities, so the
 * registry supplies them. Its models cache only the prompt prefixes a
 * request marks.
 */
export const anthropic: ProviderDialect = {
	name: "Anthropic",
	discoveryRoot: apiRoot,
	requestRoot: apiRoot,
	recognizeFailure: recognizeAnthropicFailure,
	languageModel: (endpoint, modelId, fetch) =>
		createAnthropic({
			apiKey: endpoint.apiKey ?? "",
			baseURL: endpoint.baseUrl,
			headers: endpoint.headers,
			fetch,
		})(modelId),
	listingUrl: (root) => `${root}/models?limit=1000`,
	authorization: (apiKey) => ({ "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }),
	cacheBreakpoint: () => ({ anthropic: { cacheControl: { type: "ephemeral" } } }),
	listing: dataListing,
	model: Schema.Struct({
		id: Schema.String,
		display_name: Schema.optional(Schema.String).pipe(
			Schema.catchDecoding(() => Effect.succeedSome(undefined)),
		),
	}).pipe(
		Schema.decodeTo(discoveredModel, {
			decode: SchemaGetter.transform(
				(entry): ProviderModelFields => ({ modelId: entry.id, displayName: entry.display_name }),
			),
			encode: SchemaGetter.forbiddenEncoding,
		}),
	),
};

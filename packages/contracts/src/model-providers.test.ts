import { Result, Schema, SchemaIssue } from "effect";
import { describe, expect, it } from "vitest";
import { connectionUpdateSchema, newConnectionSchema } from "./connections.ts";
import {
	bulkProviderModelUpdateSchema,
	effectiveCapabilities,
	modelProviderUpdateSchema,
	newCustomProviderSchema,
	newModelProviderSchema,
	newProviderModelSchema,
	providerHeaderSchema,
	providerModelUpdateSchema,
	providerUrlSchema,
} from "./model-providers.ts";
import { newSearchProviderSchema, searchProviderUpdateSchema } from "./search-providers.ts";

const customProvider = {
	name: "Gateway",
	baseUrl: "https://gateway.example/v1",
	apiFormat: "openai",
} satisfies typeof newCustomProviderSchema.Encoded;

describe("new model providers", () => {
	it("takes a preset with only a key, or a custom endpoint described in full", () => {
		const decode = Schema.decodeUnknownSync(newModelProviderSchema);
		expect(decode({ preset: "groq", apiKey: "k" })).toEqual({ preset: "groq", apiKey: "k" });
		expect(decode({ preset: "ollama" })).toEqual({ preset: "ollama" });
		expect(decode(customProvider)).toEqual({ ...customProvider, customHeaders: [] });
		expect(() => decode({ preset: "nonesuch" })).toThrow();
		expect(() => decode({ name: "Gateway" })).toThrow();
	});

	it("keeps a catalog provider's name for the preset after trimming and case folding", () => {
		const decode = Schema.decodeUnknownSync(newCustomProviderSchema);
		for (const name of ["OpenRouter", "  oPeNrOuTeR  ", " "]) {
			expect(() => decode({ ...customProvider, name })).toThrow();
		}
		expect(decode({ ...customProvider, name: " Gateway " }).name).toBe("Gateway");
	});

	it("defaults absent and undefined arrays without sharing mutable defaults", () => {
		const decode = Schema.decodeUnknownSync(newCustomProviderSchema);
		const first = decode(customProvider);
		first.customHeaders.push({ name: "X-Test", value: "one" });
		expect(decode({ ...customProvider, customHeaders: undefined }).customHeaders).toEqual([]);
		expect(() => decode({ ...customProvider, customHeaders: null })).toThrow();
	});
});

describe("provider URL security", () => {
	it.each(["http://localhost:11434/v1", "https://models.example/v1", "HTTP://127.0.0.1:8080"])(
		"leaves the network policy to the API: %s",
		(baseUrl) => {
			expect(Schema.decodeSync(providerUrlSchema)(baseUrl)).toBe(baseUrl);
		},
	);

	it("trims URLs without normalizing their spelling or path", () => {
		expect(Schema.decodeSync(providerUrlSchema)("  https://Models.example:443/v1  ")).toBe(
			"https://Models.example:443/v1",
		);
	});

	it.each([
		"not a URL",
		"https://",
		"ftp://models.example/v1",
		"https://user:secret@models.example/v1",
		"https://@models.example/v1",
		"https://models.example/v1#fragment",
		"https://models.example/v1#",
	])("rejects an unsafe provider URL: %s", (baseUrl) => {
		expect(() => Schema.decodeSync(providerUrlSchema)(baseUrl)).toThrow();
	});
});

describe("provider headers", () => {
	it.each([
		"Authorization",
		"x-api-key",
		"Host",
		"Content-Length",
		"Connection",
		"Transfer-Encoding",
		"Cookie",
		"Proxy-Custom",
		"Sec-Custom",
		" Origin ",
	])("rejects reserved custom header %s", (name) => {
		expect(() => Schema.decodeSync(providerHeaderSchema)({ name, value: "secret" })).toThrow();
	});

	it("trims names but preserves values and strips unknown keys", () => {
		expect(
			Schema.decodeUnknownSync(providerHeaderSchema)({
				name: " X-Workspace ",
				value: "  secret  ",
				unknown: true,
			}),
		).toEqual({ name: "X-Workspace", value: "  secret  " });
	});

	it.each([
		{ name: "bad header", value: "one" },
		{ name: "", value: "one" },
		{ name: "x".repeat(129), value: "one" },
		{ name: "X-Test", value: "one\rtwo" },
		{ name: "X-Test", value: "one\ntwo" },
		{ name: "X-Test", value: "x".repeat(2049) },
	])("rejects invalid headers: %j", (header) => {
		expect(() => Schema.decodeSync(providerHeaderSchema)(header)).toThrow();
	});

	it("reports every case-insensitive duplicate at its trimmed name's index", () => {
		const result = Schema.decodeResult(modelProviderUpdateSchema)({
			customHeaders: [
				{ name: "X-Workspace", value: "one" },
				{ name: " x-workspace ", value: "two" },
				{ name: "X-WORKSPACE", value: "three" },
			],
		});
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues).toEqual([
				{ path: ["customHeaders", 1, "name"], message: "Header names must be unique" },
				{ path: ["customHeaders", 2, "name"], message: "Header names must be unique" },
			]);
		}
	});

	it("limits custom headers to twenty", () => {
		const decode = Schema.decodeUnknownSync(modelProviderUpdateSchema);
		const customHeaders = Array.from({ length: 20 }, (_, i) => ({ name: `X-${i}`, value: "" }));
		expect(decode({ customHeaders }).customHeaders).toHaveLength(20);
		expect(() =>
			decode({ customHeaders: [...customHeaders, { name: "X-20", value: "" }] }),
		).toThrow();
	});
});

describe("partial updates", () => {
	it.each([
		["model", modelProviderUpdateSchema, "apiKey"],
		["search", searchProviderUpdateSchema, "apiKey"],
		["connection", connectionUpdateSchema, "secret"],
	] as const)("preserves absent, undefined and null semantics for %s", (_, schema, key) => {
		const decode = Schema.decodeUnknownSync(schema);
		expect(() => decode({})).toThrow("Nothing to change");
		expect(() => decode({ unknown: true })).toThrow("Nothing to change");
		expect(decode({ [key]: null, unknown: true })).toEqual({ [key]: null });
		expect(() => decode({ [key]: "" })).toThrow();
		// Trimmed: a key pasted with a stray space would be sent as an empty bearer token.
		expect(() => decode({ [key]: " " })).toThrow();
		expect(decode({ [key]: " k\n" })).toEqual({ [key]: "k" });
		expect(() => decode({ [key]: "x".repeat(4097) })).toThrow();
	});

	it("does not apply creation defaults during model updates", () => {
		expect(
			Schema.decodeUnknownSync(modelProviderUpdateSchema)({ active: false, unknown: true }),
		).toEqual({ active: false });
	});

	it("takes a connection's secret header trimmed, including the credential headers a provider may not set", () => {
		const decode = Schema.decodeUnknownSync(newConnectionSchema);
		expect(
			decode({ name: " Server ", url: customProvider.baseUrl, secretHeader: " X-Secret " }),
		).toEqual({
			name: "Server",
			url: customProvider.baseUrl,
			secretHeader: "X-Secret",
		});
		expect(
			decode({ name: "Server", url: customProvider.baseUrl, secretHeader: "Authorization" })
				.secretHeader,
		).toBe("Authorization");
		expect(() =>
			decode({ name: "Server", url: customProvider.baseUrl, secretHeader: "Host" }),
		).toThrow();
		expect(Schema.decodeSync(connectionUpdateSchema)({ secretHeader: null })).toEqual({
			secretHeader: null,
		});
	});

	it("keeps search creation fields optional but not nullable", () => {
		const decode = Schema.decodeUnknownSync(newSearchProviderSchema);
		expect(decode({ preset: "exa", unknown: true })).toEqual({ preset: "exa" });
		expect(decode({ preset: "exa", enabled: false })).toEqual({ preset: "exa", enabled: false });
		expect(() => decode({ preset: "exa", apiKey: null })).toThrow();
	});
});

describe("provider models", () => {
	it("preserves nullish fields, trimming and independent array defaults", () => {
		const decode = Schema.decodeUnknownSync(newProviderModelSchema);
		const first = decode({ modelId: "model" });
		first.capabilities.push("tools");
		expect(decode({ modelId: "model", capabilities: undefined })).toEqual({
			modelId: "model",
			capabilities: [],
		});
		expect(decode({ modelId: "model", displayName: null, contextLength: null })).toEqual({
			modelId: "model",
			displayName: null,
			contextLength: null,
			capabilities: [],
		});
		expect(
			decode({ modelId: "model", displayName: " Model ", contextLength: 10_000_000 }).displayName,
		).toBe("Model");
		expect(() => decode({ modelId: "model", displayName: " " })).toThrow();
	});

	it.each([0, -1, 1.5, 10_000_001, Infinity, NaN])(
		"rejects invalid context length %s",
		(contextLength) => {
			expect(() =>
				Schema.decodeSync(newProviderModelSchema)({ modelId: "model", contextLength }),
			).toThrow();
		},
	);

	it("requires a nonempty UUID array for bulk updates", () => {
		const decode = Schema.decodeUnknownSync(bulkProviderModelUpdateSchema);
		expect(() => decode({ modelIds: [], enabled: true })).toThrow();
		expect(() => decode({ modelIds: ["bad"], enabled: true })).toThrow();
		expect(
			decode({ modelIds: ["00000000-0000-0000-0000-000000000000"], enabled: false }).modelIds,
		).toHaveLength(1);
	});
});

describe("a provider's API key", () => {
	it("is trimmed, since a key pasted with a stray space is sent as an empty bearer token", () => {
		const decode = Schema.decodeUnknownSync(newModelProviderSchema);
		expect(decode({ preset: "openrouter", apiKey: "  sk-or-v1-abc\n" })).toEqual({
			preset: "openrouter",
			apiKey: "sk-or-v1-abc",
		});
		expect(() => decode({ preset: "openrouter", apiKey: "   " })).toThrow();
	});
});

describe("a provider model update", () => {
	it("changes the switch or the capability lists, and refuses nothing at all", () => {
		const accepts = (input: unknown) =>
			Result.isSuccess(Schema.decodeUnknownResult(providerModelUpdateSchema)(input));
		expect(accepts({ enabled: true })).toBe(true);
		expect(accepts({ disabledCapabilities: ["vision"] })).toBe(true);
		expect(accepts({ capabilities: ["tools", "vision"] })).toBe(true);
		expect(accepts({ disabledCapabilities: ["tools", "tools"] })).toBe(false);
		expect(accepts({ capabilities: ["flying"] })).toBe(false);
		expect(accepts({})).toBe(false);
	});

	it("leaves agents what the model has less what was switched off", () => {
		expect(
			effectiveCapabilities({
				capabilities: ["tools", "vision", "images"],
				disabledCapabilities: ["vision", "audio"],
			}),
		).toEqual(["tools", "images"]);
	});
});

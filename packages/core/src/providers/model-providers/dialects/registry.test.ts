import { describe, expect, it } from "vitest";
import type { DiscoveredModel, ProviderIdentity } from "./dialect.ts";
import { type ModelRegistry, type RegistrySource, registryFrom } from "./registry.ts";

type Entry = RegistrySource[string]["models"][string];
const entry = (overrides: Entry = {}): Entry => overrides;

const source: RegistrySource = {
	openai: {
		models: {
			"gpt-4o": entry({
				name: "GPT-4o",
				tool_call: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 128_000 },
				cost: { input: 2.5, output: 10, cache_read: 1.25 },
			}),
			"text-embedding-3-small": entry({
				name: "text-embedding-3-small",
				limit: { context: 8_191 },
			}),
			"gpt-image-1": entry({ modalities: { input: ["text"], output: ["image"] } }),
			"shared-id": entry({ name: "From the vendor", tool_call: true }),
		},
	},
	openrouter: {
		api: "https://openrouter.ai/api/v1",
		models: {
			"openai/gpt-4o": entry({
				name: "OpenAI: GPT-4o",
				tool_call: true,
				limit: { context: 128_000 },
			}),
		},
	},
	"some-gateway": {
		api: "https://gateway.example/v1",
		models: {
			"shared-id": entry({ name: "From a gateway", reasoning: true }),
			"gateway-only": entry({ name: "Gateway only", tool_call: true, limit: { context: 4_000 } }),
		},
	},
};

const blank = (modelId: string): DiscoveredModel => ({
	modelId,
	displayName: null,
	capabilities: [],
	contextLength: null,
});

const openai: ProviderIdentity = {
	preset: "openai",
	baseUrl: "https://api.openai.com/v1",
	apiFormat: "openai",
};
const custom = (baseUrl: string): ProviderIdentity => ({
	preset: null,
	baseUrl,
	apiFormat: "openai",
});

describe("registryFrom", () => {
	const registry: ModelRegistry = registryFrom(source, "2026-09-01T00:00:00.000Z");

	it("prices a model from the catalog, and says when the catalog was compiled", () => {
		expect(registry.price("gpt-4o", openai)).toEqual({
			cost: { input: 2.5, output: 10, cache_read: 1.25 },
			catalogGeneratedAt: "2026-09-01T00:00:00.000Z",
		});
		expect(registry.price("gpt-image-1", openai)).toBeUndefined();
	});

	it("fills a preset's model from that provider's entry", () => {
		expect(registry.complete(blank("gpt-4o"), openai)).toEqual({
			modelId: "gpt-4o",
			displayName: "GPT-4o",
			capabilities: ["tools", "vision"],
			contextLength: 128_000,
		});
	});

	it("reads image output as image generation, and a zero context as unknown", () => {
		expect(registry.complete(blank("gpt-image-1"), openai)).toMatchObject({
			capabilities: ["images"],
			contextLength: null,
		});
	});

	it("marks an embedding model by its name, since the registry has no word for it", () => {
		expect(registry.complete(blank("text-embedding-3-small"), openai).capabilities).toEqual([
			"embeddings",
		]);
	});

	it("matches a custom provider by host", () => {
		expect(
			registry.complete(blank("gateway-only"), custom("https://gateway.example/v1")),
		).toMatchObject({ displayName: "Gateway only", capabilities: ["tools"], contextLength: 4_000 });
		expect(
			registry.complete(blank("shared-id"), custom("https://gateway.example/v1")).displayName,
		).toBe("From a gateway");
	});

	it("falls back to the bare id across providers, preferring the vendor", () => {
		expect(
			registry.complete(blank("shared-id"), custom("https://unknown.example/v1")),
		).toMatchObject({ displayName: "From the vendor", capabilities: ["tools"] });
		expect(
			registry.complete(blank("vendor/gpt-4o"), custom("https://unknown.example/v1")).capabilities,
		).toEqual(["tools", "vision"]);
	});

	it("believes the provider over models.dev wherever the provider spoke", () => {
		const reported: DiscoveredModel = {
			modelId: "gpt-4o",
			displayName: "Ours",
			capabilities: ["tools"],
			contextLength: 64_000,
		};
		expect(registry.complete(reported, openai)).toEqual(reported);
	});

	it("leaves an unknown model unchanged", () => {
		expect(registry.complete(blank("llama3.2:latest"), openai)).toEqual(blank("llama3.2:latest"));
	});
});

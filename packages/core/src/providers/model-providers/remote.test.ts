import { Effect, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import type { EgressHttpClients } from "../network/egress.ts";
import { type DiscoveredModel, emptyRegistry, type ModelRegistry } from "./dialects/index.ts";
import { registryFrom } from "./dialects/registry.ts";
import { fetchProviderModels } from "./remote.ts";
import type { ProviderConnection } from "./store.ts";

/** Discovery reads the connection the fake store hands it, so nothing reaches the database. */
const run = effectRunner(ManagedRuntime.make(noDatabase));

function connection(overrides: Partial<ProviderConnection>): ProviderConnection {
	return {
		providerId: "provider-id",
		preset: null,
		baseUrl: "https://models.example/v1",
		apiFormat: "openai",
		apiKey: "secret",
		headers: {},
		configurationUpdatedAt: new Date(),
		...overrides,
	};
}

/** A store that remembers what discovery told it, and reports it all as new. */
function store(found: ProviderConnection) {
	const synced: DiscoveredModel[][] = [];
	return {
		synced,
		connection: vi.fn(() => Effect.succeed(found)),
		syncDiscovered: vi.fn((_workspaceId: string, _providerId: string, models: DiscoveredModel[]) =>
			Effect.sync(() => {
				synced.push(models);
				return { added: models.length, updated: 0 };
			}),
		),
		recordTest: vi.fn(() => Effect.void),
	};
}

/** The client discovery is handed, and the root it asked to be bound to. */
function clients(httpClient: (url: string, init?: RequestInit) => Promise<Response>) {
	const roots: string[] = [];
	const httpClients: EgressHttpClients = {
		for: ({ baseUrl }) => {
			roots.push(baseUrl);
			return httpClient as unknown as typeof fetch;
		},
	};
	return { httpClients, roots };
}

/** Runs discovery for `found` against `httpClient`, consulting no registry unless given one. */
function discover(
	models: ReturnType<typeof store>,
	found: ProviderConnection,
	httpClient: (url: string, init?: RequestInit) => Promise<Response>,
	registry: ModelRegistry = emptyRegistry,
) {
	const { httpClients, roots } = clients(httpClient);
	return {
		roots,
		result: run(
			fetchProviderModels(models, "workspace-id", found.providerId, httpClients, registry),
		),
	};
}

/** A registry that knows two OpenAI models and one Anthropic one. */
const knownModels = registryFrom({
	openai: {
		models: {
			"gpt-4o": {
				name: "GPT-4o",
				tool_call: true,
				reasoning: false,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 128_000 },
			},
			"text-embedding-3-small": {
				name: "text-embedding-3-small",
				tool_call: false,
				reasoning: false,
				modalities: { input: ["text"], output: ["text"] },
				limit: { context: 8_191 },
			},
		},
	},
	anthropic: {
		models: {
			"claude-sonnet-4-5": {
				name: "Claude Sonnet 4.5",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image", "pdf"], output: ["text"] },
				limit: { context: 200_000 },
			},
		},
	},
});

it("uses the injected http client for model discovery", async () => {
	const found = connection({ headers: { "x-workspace": "workspace" } });
	const models = store(found);
	const httpClient = vi.fn(async () =>
		Response.json({ data: [{ id: "remote-model", name: "Remote model" }] }),
	);

	await expect(discover(models, found, httpClient).result).resolves.toEqual({
		added: 1,
		updated: 0,
		unchanged: 0,
	});
	expect(httpClient).toHaveBeenCalledWith(
		"https://models.example/v1/models",
		expect.objectContaining({
			headers: {
				authorization: "Bearer secret",
				"x-workspace": "workspace",
			},
		}),
	);
	expect(models.synced[0]).toEqual([
		{ modelId: "remote-model", displayName: "Remote model", capabilities: [], contextLength: null },
	]);
});

it("fills in from the registry what a listing says nothing about", async () => {
	const found = connection({ preset: "openai", baseUrl: "https://api.openai.com/v1" });
	const models = store(found);
	const httpClient = vi.fn(async () =>
		Response.json({ data: [{ id: "gpt-4o", object: "model" }, { id: "text-embedding-3-small" }] }),
	);

	await discover(models, found, httpClient, knownModels).result;

	expect(models.synced[0]).toEqual([
		{
			modelId: "gpt-4o",
			displayName: "GPT-4o",
			capabilities: ["tools", "vision"],
			contextLength: 128_000,
		},
		{
			modelId: "text-embedding-3-small",
			displayName: "text-embedding-3-small",
			capabilities: ["embeddings"],
			contextLength: 8_191,
		},
	]);
});

it("asks Anthropic for a whole page and keys with its own header", async () => {
	const found = connection({
		preset: "anthropic",
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
	});
	const models = store(found);
	const httpClient = vi.fn(async () =>
		Response.json({
			data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" }],
			has_more: false,
		}),
	);

	await discover(models, found, httpClient, knownModels).result;

	expect(httpClient).toHaveBeenCalledWith(
		"https://api.anthropic.com/v1/models?limit=1000",
		expect.objectContaining({
			headers: { "x-api-key": "secret", "anthropic-version": "2023-06-01" },
		}),
	);
	expect(models.synced[0]).toEqual([
		{
			modelId: "claude-sonnet-4-5",
			displayName: "Claude Sonnet 4.5",
			capabilities: ["tools", "reasoning", "vision"],
			contextLength: 200_000,
		},
	]);
});

it("asks Ollama about each model through its native API, without an authorization header", async () => {
	const found = connection({
		preset: "ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		apiKey: undefined,
	});
	const models = store(found);
	const httpClient = vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith("/api/tags")) {
			return Response.json({ models: [{ name: "llama3.2:latest" }, { name: "nomic-embed-text" }] });
		}
		const { model } = JSON.parse(String(init?.body)) as { model: string };
		return model === "llama3.2:latest"
			? Response.json({
					capabilities: ["completion", "tools", "thinking"],
					model_info: { "llama.context_length": 131_072 },
				})
			: Response.json({ capabilities: ["embedding"], model_info: {} });
	});

	const { roots, result } = discover(models, found, httpClient);
	await result;

	expect(roots).toEqual(["http://127.0.0.1:11434"]);
	expect(httpClient).toHaveBeenCalledWith(
		"http://127.0.0.1:11434/api/tags",
		expect.objectContaining({ headers: {} }),
	);
	expect(httpClient).toHaveBeenCalledWith(
		"http://127.0.0.1:11434/api/show",
		expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "llama3.2:latest" }) }),
	);
	expect(models.synced[0]).toEqual([
		{
			modelId: "llama3.2:latest",
			displayName: null,
			capabilities: ["tools", "reasoning"],
			contextLength: 131_072,
		},
		{
			modelId: "nomic-embed-text",
			displayName: null,
			capabilities: ["embeddings"],
			contextLength: null,
		},
	]);
});

it("keeps a listed model when Ollama cannot describe it", async () => {
	const found = connection({
		preset: "ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		apiKey: undefined,
	});
	const models = store(found);
	const httpClient = vi.fn(async (url: string) =>
		url.endsWith("/api/tags")
			? Response.json({ models: [{ name: "mystery" }] })
			: new Response(null, { status: 500 }),
	);

	await expect(discover(models, found, httpClient).result).resolves.toEqual({
		added: 1,
		updated: 0,
		unchanged: 0,
	});
	expect(models.synced[0]).toEqual([
		{ modelId: "mystery", displayName: null, capabilities: [], contextLength: null },
	]);
});

it("reads OpenRouter's own account of what a model can do", async () => {
	const found = connection({ baseUrl: "https://openrouter.ai/api/v1" });
	const models = store(found);
	const httpClient = vi.fn(async () =>
		Response.json({
			data: [
				{
					id: "openai/gpt-4o",
					name: "OpenAI: GPT-4o",
					context_length: 128_000,
					architecture: {
						modality: "text+image->text",
						input_modalities: ["text", "image"],
						output_modalities: ["text"],
					},
					supported_parameters: ["tools", "temperature"],
				},
				{
					id: "some/text-only",
					name: "Text only",
					context_length: 32_000,
					architecture: { input_modalities: ["text"], output_modalities: ["text"] },
					supported_parameters: ["temperature"],
				},
			],
		}),
	);

	await discover(models, found, httpClient).result;

	expect(models.synced[0]).toEqual([
		{
			modelId: "openai/gpt-4o",
			displayName: "OpenAI: GPT-4o",
			capabilities: ["tools", "vision"],
			contextLength: 128_000,
		},
		{
			modelId: "some/text-only",
			displayName: "Text only",
			capabilities: [],
			contextLength: 32_000,
		},
	]);
});

it("records a model a listing names twice once", async () => {
	const found = connection({});
	const models = store(found);
	const httpClient = vi.fn(async () => Response.json({ data: [{ id: "twice" }, { id: "twice" }] }));

	await expect(discover(models, found, httpClient).result).resolves.toEqual({
		added: 1,
		updated: 0,
		unchanged: 0,
	});
});

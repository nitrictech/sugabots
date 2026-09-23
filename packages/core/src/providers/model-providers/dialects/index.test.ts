import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { capabilitiesNamed, discoveredModel } from "./dialect.ts";
import { anthropic, dialectFor, ollama, openaiCompatible, openrouter } from "./index.ts";

describe("capabilitiesNamed", () => {
	const named = capabilitiesNamed({ tools: "tools", thinking: "reasoning" });

	it("translates the words it knows and drops the rest", () => {
		expect(Schema.decodeUnknownSync(named)(["completion", "tools", "thinking", "hot"])).toEqual([
			"tools",
			"reasoning",
		]);
	});

	it("reads a missing or malformed list as no capabilities", () => {
		expect(Schema.decodeUnknownSync(named)(undefined)).toEqual([]);
		expect(Schema.decodeUnknownSync(named)("tools")).toEqual([]);
		expect(Schema.decodeUnknownSync(named)([1, null])).toEqual([]);
	});
});

describe("dialectFor", () => {
	it("reads a preset in the dialect it names", () => {
		expect(
			dialectFor({ preset: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiFormat: "openai" }),
		).toBe(ollama);
		expect(
			dialectFor({
				preset: "anthropic",
				baseUrl: "https://api.anthropic.com",
				apiFormat: "anthropic",
			}),
		).toBe(anthropic);
		expect(
			dialectFor({ preset: "openai", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" }),
		).toBe(openaiCompatible);
	});

	it("reads a custom provider by its wire format, and by its host where that says more", () => {
		expect(
			dialectFor({ preset: null, baseUrl: "https://proxy.example/v1", apiFormat: "anthropic" }),
		).toBe(anthropic);
		expect(
			dialectFor({ preset: null, baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" }),
		).toBe(openrouter);
		expect(
			dialectFor({
				preset: null,
				baseUrl: "https://api.groq.com/openai/v1",
				apiFormat: "openai",
			}),
		).toBe(openaiCompatible);
	});
});

describe("openaiCompatible", () => {
	it("reads the vision hint and context length a richer listing carries", () => {
		expect(
			Schema.decodeUnknownSync(openaiCompatible.model)({
				id: "local/vision-model",
				name: "Vision",
				architecture: { modality: "text+image->text" },
				context_length: 32_000,
			}),
		).toEqual({
			modelId: "local/vision-model",
			displayName: "Vision",
			capabilities: ["vision"],
			contextLength: 32_000,
		});
	});

	it("does not mistake image output for image input", () => {
		expect(
			Schema.decodeUnknownSync(openaiCompatible.model)({
				id: "painter",
				architecture: { modality: "text->image" },
			}).capabilities,
		).toEqual([]);
	});

	it("skips an entry that is not a model", () => {
		expect(Schema.decodeUnknownResult(openaiCompatible.model)({ object: "model" })._tag).toBe(
			"Failure",
		);
		expect(
			Schema.decodeUnknownResult(openaiCompatible.model)({ id: "has spaces in it" })._tag,
		).toBe("Failure");
		expect(Schema.decodeUnknownResult(openaiCompatible.model)("gpt-4o")._tag).toBe("Failure");
	});

	it("keeps a model whose extra fields are not what the listing promised", () => {
		expect(
			Schema.decodeUnknownSync(openaiCompatible.model)({
				id: "odd",
				name: 7,
				architecture: null,
				context_length: "8k",
			}),
		).toEqual({ modelId: "odd", displayName: null, capabilities: [], contextLength: null });
	});

	it("sends no authorization without a key", () => {
		expect(openaiCompatible.authorization(undefined)).toEqual({});
	});
});

describe("anthropic", () => {
	it("defaults missing fields and ignores malformed display metadata", () => {
		for (const display_name of [undefined, null, 7, {}]) {
			expect(Schema.decodeUnknownSync(anthropic.model)({ id: "claude", display_name })).toEqual({
				modelId: "claude",
				displayName: null,
				capabilities: [],
				contextLength: null,
			});
		}
	});
	it("adds the version path once", () => {
		expect(anthropic.discoveryRoot?.("https://api.anthropic.com")).toBe(
			"https://api.anthropic.com/v1",
		);
		expect(anthropic.discoveryRoot?.("https://api.anthropic.com/v1")).toBe(
			"https://api.anthropic.com/v1",
		);
	});
});

describe("ollama", () => {
	it("normalizes missing and malformed inspection metadata", async () => {
		const model = Schema.decodeUnknownSync(ollama.model)({ name: "model" });
		const inspect = ollama.inspect;
		if (!inspect) throw new Error("Ollama must support inspection");
		for (const body of [
			{},
			{ capabilities: null, model_info: null },
			{ capabilities: [7], model_info: [] },
		]) {
			expect(
				await Effect.runPromise(inspect("http://ollama", model, async () => Response.json(body))),
			).toEqual(model);
		}
	});

	it("keeps the listed model when inspection is malformed or violates the contract", async () => {
		const model = Schema.decodeUnknownSync(ollama.model)({ name: "model" });
		const inspect = ollama.inspect;
		if (!inspect) throw new Error("Ollama must support inspection");
		for (const body of [
			null,
			{ capabilities: ["vision"], model_info: { "llama.context_length": "8k" } },
		]) {
			expect(
				await Effect.runPromise(inspect("http://ollama", model, async () => Response.json(body))),
			).toBe(model);
		}
	});

	it("steps out of the OpenAI-compatible path to the root the native API shares", () => {
		expect(ollama.discoveryRoot?.("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
		expect(ollama.discoveryRoot?.("http://host/ollama/v1")).toBe("http://host/ollama");
		expect(ollama.listingUrl("http://host/ollama")).toBe("http://host/ollama/api/tags");
	});

	it("reads the native listing", () => {
		expect(Schema.decodeUnknownSync(ollama.listing)({ models: [{ name: "a" }] })).toEqual([
			{ name: "a" },
		]);
		expect(Schema.decodeUnknownResult(ollama.listing)({ data: [] })._tag).toBe("Failure");
		expect(
			Schema.decodeUnknownSync(ollama.model)({ name: "llama3.2:latest", model: "llama3.2:latest" })
				.modelId,
		).toBe("llama3.2:latest");
	});
});

describe("discovery decoding parity", () => {
	it("normalizes nulls, trims names, and deduplicates capabilities into mutable outputs", () => {
		const model = Schema.decodeUnknownSync(discoveredModel)({
			modelId: "model",
			displayName: " Model ",
			contextLength: null,
			capabilities: ["tools", "tools", "vision"],
		});
		expect(model).toEqual({
			modelId: "model",
			displayName: "Model",
			contextLength: null,
			capabilities: ["tools", "vision"],
		});
		model.displayName = null;
		model.capabilities.push("reasoning");
		expect(model.capabilities).toEqual(["tools", "vision", "reasoning"]);
	});

	it("rejects numeric context lengths outside the contract", () => {
		for (const context_length of [0, -1, 1.5, 10_000_001]) {
			expect(
				Schema.decodeUnknownResult(openaiCompatible.model)({ id: "model", context_length })._tag,
			).toBe("Failure");
		}
	});

	it("keeps OpenRouter models with missing or malformed optional metadata", () => {
		for (const architecture of [
			undefined,
			null,
			7,
			{},
			{ input_modalities: [1], output_modalities: "image" },
		]) {
			expect(
				Schema.decodeUnknownSync(openrouter.model)({
					id: "model",
					name: null,
					architecture,
					supported_parameters: [null],
					context_length: "8k",
				}),
			).toEqual({ modelId: "model", displayName: null, capabilities: [], contextLength: null });
		}
	});

	it("reads all OpenRouter capabilities", () => {
		expect(
			Schema.decodeUnknownSync(openrouter.model)({
				id: "model",
				architecture: {
					input_modalities: ["text", "image", "audio"],
					output_modalities: ["image"],
				},
				supported_parameters: ["tools", "reasoning"],
				context_length: 8192,
			}).capabilities,
		).toEqual(["tools", "reasoning", "vision", "audio", "images"]);
	});

	it("does not discard valid architecture metadata beside malformed metadata", () => {
		expect(
			Schema.decodeUnknownSync(openrouter.model)({
				id: "model",
				architecture: { input_modalities: ["image"], output_modalities: 7 },
			}).capabilities,
		).toEqual(["vision"]);
	});

	it("validates listing envelopes without prematurely validating entries", () => {
		expect(
			Schema.decodeUnknownSync(openaiCompatible.listing)({ data: [null, 1, { id: "model" }] }),
		).toEqual([null, 1, { id: "model" }]);
		for (const body of [null, {}, { data: null }, { data: {} }]) {
			expect(Schema.decodeUnknownResult(openaiCompatible.listing)(body)._tag).toBe("Failure");
		}
	});
});

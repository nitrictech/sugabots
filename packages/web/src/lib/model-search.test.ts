import { describe, expect, it } from "vitest";
import { searchModels } from "./model-search.ts";

const models = [
	{ modelId: "openai/gpt-4o", displayName: "OpenAI: GPT-4o" },
	{ modelId: "openai/gpt-4o-mini", displayName: "OpenAI: GPT-4o-mini" },
	{ modelId: "anthropic/claude-fable-5.1", displayName: null },
	{ modelId: "google/gemini-2.5-flash", displayName: "Google: Gemini 2.5 Flash" },
	{ modelId: "meta-llama/llama-3.3-70b-instruct", displayName: "Meta: Llama 3.3 70B Instruct" },
];

const ids = (query: string) => searchModels(models, query).map((model) => model.modelId);

describe("model search", () => {
	it("matches an id without its separators", () => {
		expect(ids("gpt4o")).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
	});

	it("matches words in any order", () => {
		expect(ids("70b llama")).toEqual(["meta-llama/llama-3.3-70b-instruct"]);
	});

	it("forgives a letter missing or swapped", () => {
		expect(ids("gemni flash")).toEqual(["google/gemini-2.5-flash"]);
		expect(ids("fabel")).toEqual(["anthropic/claude-fable-5.1"]);
	});

	it("ranks a closer match first", () => {
		expect(ids("gpt 4o mini")[0]).toBe("openai/gpt-4o-mini");
	});

	it("keeps every model, in order, for an empty query, and none for an unrelated one", () => {
		expect(ids("  ")).toEqual(models.map((model) => model.modelId));
		expect(ids("whisper")).toEqual([]);
	});
});

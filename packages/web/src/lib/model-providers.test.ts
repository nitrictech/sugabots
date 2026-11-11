import type { ModelProvider, ProviderModel } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { offeredModelsOf } from "./model-providers.ts";

function model(modelId: string, over: Partial<ProviderModel> = {}): ProviderModel {
	return {
		id: `0199a3a0-0000-7000-8000-${modelId.padStart(12, "0")}`,
		modelId,
		displayName: null,
		capabilities: ["tools"],
		disabledCapabilities: [],
		contextLength: null,
		enabled: true,
		source: "fetched",
		...over,
	};
}

function provider(models: ProviderModel[], over: Partial<ModelProvider> = {}): ModelProvider {
	return {
		id: "0199a3a0-0000-7000-8000-000000000201",
		workspaceId: "0199a3a0-0000-7000-8000-000000000101",
		preset: "openai",
		name: "OpenAI",
		baseUrl: "https://api.example.com/v1",
		apiFormat: "openai",
		active: true,
		status: "connected",
		hasApiKey: true,
		signedIn: false,
		customHeaders: [],
		modelCount: models.length,
		enabledModelCount: models.filter((one) => one.enabled).length,
		lastTestedAt: null,
		lastTestError: null,
		connectedBy: null,
		models,
		...over,
	};
}

const ids = (models: ProviderModel[]) => models.map((one) => one.modelId);

describe("offered models", () => {
	it("are the switched-on models of a provider that is on", () => {
		const models = [model("1"), model("2", { enabled: false })];
		expect(ids(offeredModelsOf(provider(models)))).toEqual(["1"]);
	});

	it("leave out an embedding model, unless its embeddings are switched off", () => {
		const models = [
			model("1", { capabilities: ["embeddings"] }),
			model("2", { capabilities: ["embeddings"], disabledCapabilities: ["embeddings"] }),
		];
		expect(ids(offeredModelsOf(provider(models)))).toEqual(["2"]);
	});

	it("are none while the provider is switched off", () => {
		expect(offeredModelsOf(provider([model("1")], { active: false }))).toEqual([]);
	});

	it("are none while the provider lacks its key", () => {
		expect(offeredModelsOf(provider([model("1")], { hasApiKey: false }))).toEqual([]);
	});
});

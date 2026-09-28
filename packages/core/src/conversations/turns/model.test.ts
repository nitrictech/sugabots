import { Effect, ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";

const sdk = vi.hoisted(() => ({
	createAnthropic: vi.fn(),
	createOpenAI: vi.fn(),
	anthropicModel: vi.fn(),
	openAiChatModel: vi.fn(),
	streamText: vi.fn(() => ({
		textStream: [],
		usage: Promise.resolve({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			outputTokenDetails: { reasoningTokens: 0 },
			inputTokenDetails: { cacheReadTokens: 0 },
		}),
		steps: Promise.resolve([]),
	})),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: sdk.createAnthropic }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: sdk.createOpenAI }));
vi.mock("ai", async (importOriginal) => ({
	// The error class is real: describing a failure is about what it carries.
	APICallError: (await importOriginal<typeof import("ai")>()).APICallError,
	stepCountIs: vi.fn(),
	streamText: sdk.streamText,
}));

import { APICallError } from "ai";
import { ModelRequestFailed, workspaceTurnModel } from "./model.ts";

/** The fake resolver never queries, so nothing here reaches the database. */
const run = effectRunner(ManagedRuntime.make(noDatabase));

describe("workspace turn model", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sdk.createAnthropic.mockReturnValue(sdk.anthropicModel);
		sdk.createOpenAI.mockReturnValue({ chat: sdk.openAiChatModel });
	});

	it.each(["openai", "anthropic"] as const)(
		"injects the provider's http client into the %s SDK",
		async (apiFormat) => {
			const httpClient = vi.fn<typeof fetch>();
			const model = workspaceTurnModel({
				modelProviders: {
					resolve: () =>
						Effect.succeed({
							providerId: "provider-id",
							preset: null,
							baseUrl: "https://models.example/v1",
							apiFormat,
							apiKey: "secret",
							headers: { "x-workspace": "workspace" },
							configurationUpdatedAt: new Date(),
						}),
				},
				httpClients: { for: () => httpClient },
			});

			await run(
				model.stream({
					workspaceId: "workspace-id",
					model: "model-id",
					system: "",
					messages: [],
					signal: new AbortController().signal,
				}),
			);

			const createProvider = apiFormat === "anthropic" ? sdk.createAnthropic : sdk.createOpenAI;
			expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ fetch: httpClient }));
		},
	);
});

describe("a failed model request", () => {
	it("logs what the provider said, and tells people only what it means", () => {
		const refused = new APICallError({
			message: "Forbidden",
			url: "https://openrouter.ai/api/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 403,
			responseBody: JSON.stringify({
				error: {
					message:
						"This model requires you to complete the following before use: 18+ age confirmation.",
				},
			}),
		});

		const failure = ModelRequestFailed.fromCause(refused);

		expect(failure.message).toBe(
			"Provider returned 403: This model requires you to complete the following before use: 18+ age confirmation.",
		);
		expect(failure.userMessage).toBe("The model provider refused the request. Check its API key.");
	});

	it("logs the SDK's message when the body says nothing readable", () => {
		const opaque = new APICallError({
			message: "Bad Gateway",
			url: "https://models.example/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 502,
			responseBody: "<html>upstream timed out</html>",
		});

		expect(ModelRequestFailed.fromCause(opaque)).toMatchObject({
			message: "Provider returned 502: <html>upstream timed out</html>",
			userMessage: "The model provider could not answer.",
		});
		expect(ModelRequestFailed.fromCause(new Error("socket hang up")).message).toBe(
			"socket hang up",
		);
	});
});

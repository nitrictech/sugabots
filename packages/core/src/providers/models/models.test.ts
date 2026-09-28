import { Effect, ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { emptyRegistry } from "../../providers/model-providers/dialects/index.ts";

const sdk = vi.hoisted(() => ({
	createAnthropic: vi.fn(),
	createOpenAI: vi.fn(),
	anthropicModel: vi.fn(),
	openAiChatModel: vi.fn(),
	openAiResponsesModel: vi.fn(),
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
import { Models } from "./models.ts";

/** The fake resolver never queries, so nothing here reaches the database. */
const run = effectRunner(ManagedRuntime.make(noDatabase));

describe("models", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sdk.createAnthropic.mockReturnValue(sdk.anthropicModel);
		sdk.createOpenAI.mockReturnValue({
			chat: sdk.openAiChatModel,
			responses: sdk.openAiResponsesModel,
		});
	});

	it.each(["openai", "anthropic"] as const)(
		"injects the provider's http client into the %s SDK",
		async (apiFormat) => {
			const httpClient = vi.fn<typeof fetch>();
			const model = Models.make({
				modelProviders: {
					renewChatgptTokens: () => Effect.die(new Error("Not a ChatGPT provider")),
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
				requests: { start: () => Effect.succeed("request-id"), finish: () => Effect.void },
				registry: emptyRegistry,
			});

			await run(
				model.stream({
					workspaceId: "workspace-id",
					activity: { purpose: "probe" },
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

	it("asks the Codex backend the way Codex does for a ChatGPT subscription", async () => {
		const tokens = {
			access: "access-token",
			refresh: "refresh-token",
			expiresAt: Date.now() + 60 * 60_000,
			accountId: "account-1",
		};
		const model = Models.make({
			modelProviders: {
				renewChatgptTokens: (_workspaceId, _providerId, renew) => renew(tokens),
				resolve: () =>
					Effect.succeed({
						providerId: "provider-id",
						preset: "chatgpt",
						baseUrl: "https://chatgpt.com/backend-api/codex",
						apiFormat: "openai",
						headers: {},
						chatgptTokens: tokens,
						configurationUpdatedAt: new Date(),
					}),
			},
			httpClients: { for: () => vi.fn<typeof fetch>() },
			requests: { start: () => Effect.succeed("request-id"), finish: () => Effect.void },
			registry: emptyRegistry,
		});

		await run(
			model.stream({
				workspaceId: "workspace-id",
				activity: { purpose: "probe" },
				model: "gpt-5.5",
				system: "You are Suga.",
				messages: [{ role: "user", content: "Hello" }],
				signal: new AbortController().signal,
			}),
		);

		expect(sdk.createOpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "access-token",
				headers: expect.objectContaining({ "ChatGPT-Account-Id": "account-1" }),
			}),
		);
		expect(sdk.openAiResponsesModel).toHaveBeenCalledWith("gpt-5.5");
		const request = (sdk.streamText.mock.calls[0] as unknown[])[0];
		expect(request).toMatchObject({
			providerOptions: { openai: { instructions: "You are Suga.", store: false } },
		});
		expect(request).not.toHaveProperty("system");
	});
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

		const failure = Models.ModelRequestFailed.fromCause(refused);

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

		expect(Models.ModelRequestFailed.fromCause(opaque)).toMatchObject({
			message: "Provider returned 502: <html>upstream timed out</html>",
			userMessage: "The model provider could not answer.",
		});
		expect(Models.ModelRequestFailed.fromCause(new Error("socket hang up")).message).toBe(
			"socket hang up",
		);
	});
});

import { DisplayName } from "@sugabots/errors";
import { Duration, Effect, ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { emptyRegistry } from "../../providers/model-providers/dialects/index.ts";
import { EgressRefused } from "../network/egress.ts";

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
import { resolvedModel } from "./testing.ts";

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
					renewOAuthTokens: () => Effect.die(new Error("Not a ChatGPT provider")),
					resolve: () =>
						Effect.succeed(
							resolvedModel({
								providerId: "provider-id",
								preset: null,
								baseUrl: "https://models.example/v1",
								apiFormat,
								apiKey: "secret",
								headers: { "x-workspace": "workspace" },
								configurationUpdatedAt: new Date(),
							}),
						),
				},
				httpClients: { for: () => httpClient },
				requests: { start: () => Effect.succeed("request-id"), finish: () => Effect.void },
				registry: emptyRegistry,
			});

			await run(
				Effect.scoped(
					model.stream({
						workspaceId: "workspace-id",
						activity: { purpose: "provider-check" },
						model: "model-id",
						system: "",
						messages: [],
						maxSteps: 1,
					}),
				),
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
				renewOAuthTokens: (_workspaceId, _providerId, renew) => renew(tokens),
				resolve: () =>
					Effect.succeed(
						resolvedModel({
							providerId: "provider-id",
							preset: "chatgpt",
							baseUrl: "https://chatgpt.com/backend-api/codex",
							apiFormat: "openai",
							headers: {},
							oauthTokens: tokens,
							configurationUpdatedAt: new Date(),
						}),
					),
			},
			httpClients: { for: () => vi.fn<typeof fetch>() },
			requests: { start: () => Effect.succeed("request-id"), finish: () => Effect.void },
			registry: emptyRegistry,
		});

		await run(
			Effect.scoped(
				model.stream({
					workspaceId: "workspace-id",
					activity: { purpose: "provider-check" },
					model: "gpt-5.5",
					system: "You are Suga.",
					messages: [{ role: "user", content: "Hello" }],
					maxSteps: 1,
				}),
			),
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
	const context = {
		provider: DisplayName.fromRecord("OpenRouter"),
		model: DisplayName.fromRecord("Gemini 3.8 Flash"),
	};
	const answered = (
		statusCode: number,
		body: unknown = {},
		responseHeaders?: Record<string, string>,
	) =>
		new APICallError({
			message: "Failed",
			url: "https://models.example/v1/chat/completions",
			requestBodyValues: {},
			statusCode,
			responseBody: typeof body === "string" ? body : JSON.stringify(body),
			responseHeaders,
		});
	const unsent = (code: string) => new TypeError("fetch failed", { cause: { code } });

	it("logs what the provider said, and tells people what it means in the names they know", () => {
		const failure = Models.classifyRequestFailure(
			answered(403, {
				error: {
					message:
						"This model requires you to complete the following before use: 18+ age confirmation.",
				},
			}),
			context,
		);

		expect(failure).toMatchObject({
			_tag: "ProviderCredentialsRejected",
			message:
				"Provider returned 403: This model requires you to complete the following before use: 18+ age confirmation.",
			userMessage:
				"OpenRouter didn't accept the workspace's API key. A workspace admin can update it in Models.",
			isRetryable: false,
		});
	});

	it.each([
		["a 402", answered(402, { error: { message: "Insufficient balance" } })],
		["an exhausted quota", answered(429, { error: { code: "insufficient_quota" } })],
	])("says plainly when a provider wants payment, for %s", (_, refused) => {
		expect(Models.classifyRequestFailure(refused, context)).toMatchObject({
			_tag: "ProviderQuotaExhausted",
			isRetryable: false,
		});
	});

	it.each([
		[400, "ProviderRejectedRequest", false],
		[404, "ProviderModelNotFound", false],
		[408, "ProviderServerError", true],
		[413, "ProviderContextLengthExceeded", false],
		[429, "ProviderRateLimited", true],
		[503, "ProviderServerError", true],
	])("names a %i as %s, which may be tried again: %s", (statusCode, tag, isRetryable) => {
		expect(Models.classifyRequestFailure(answered(statusCode), context)).toMatchObject({
			_tag: tag,
			isRetryable,
		});
	});

	it("knows a prompt over the model's window from the provider's words", () => {
		const tooLong = answered(400, { error: { message: "prompt is too long: 210000 tokens" } });

		expect(Models.classifyRequestFailure(tooLong, context)._tag).toBe(
			"ProviderContextLengthExceeded",
		);
	});

	it("waits as long as a rate-limited provider asks, and says how long", () => {
		const failure = Models.classifyRequestFailure(
			answered(429, {}, { "retry-after": "90" }),
			context,
		);

		expect(failure).toMatchObject({
			_tag: "ProviderRateLimited",
			retryAfter: Duration.seconds(90),
			userMessage:
				"OpenRouter is limiting how often this workspace can ask it. Try again in 2 minutes.",
		});
	});

	it.each([
		["ECONNREFUSED", "ProviderUnreachable"],
		["ENOTFOUND", "ProviderUnreachable"],
		["UND_ERR_CONNECT_TIMEOUT", "ProviderUnreachable"],
		["ECONNRESET", "ProviderConnectionLost"],
		["UND_ERR_SOCKET", "ProviderConnectionLost"],
	])("tells a connection never made from one that dropped: %s", (code, tag) => {
		expect(Models.classifyRequestFailure(unsent(code), context)).toMatchObject({
			_tag: tag,
			isRetryable: true,
		});
	});

	it("explains an address the network policy refuses, and that it won't pass by retrying", () => {
		const refused = new APICallError({
			message: "Cannot connect to API",
			url: "http://192.168.1.20:11434/v1/chat/completions",
			requestBodyValues: {},
			cause: new EgressRefused({ reason: "privateNetwork" }),
		});

		const failure = Models.classifyRequestFailure(refused, context);

		expect(failure).toMatchObject({ _tag: "ProviderAddressRefused", isRetryable: false });
		expect(failure.userMessage).toContain("local or private network");
	});

	it("keeps an unreadable response for the logs and tells people only that it failed", () => {
		const opaque = answered(502, "<html>upstream timed out</html>");

		expect(Models.classifyRequestFailure(opaque, context)).toMatchObject({
			message: "Provider returned 502: <html>upstream timed out</html>",
			userMessage:
				"We're having trouble getting an answer from OpenRouter. Try again in a few minutes. If it keeps happening, choose another model.",
		});
		expect(Models.classifyRequestFailure(new Error("socket hang up"), context)).toMatchObject({
			_tag: "ProviderRequestFailed",
			message: "socket hang up",
		});
	});
});

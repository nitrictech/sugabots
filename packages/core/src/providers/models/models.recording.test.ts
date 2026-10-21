import { jsonSchema, tool } from "ai";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ModelRequests } from "../../accounting/model-requests.ts";
import { withImages } from "../../conversations/tools/images.ts";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import type { ProviderIdentity } from "../model-providers/dialects/index.ts";
import { IMAGE_MOVED_NOTE } from "../model-providers/dialects/tool-images.ts";
import { Models } from "./models.ts";
import { resolvedModel } from "./testing.ts";

/** The fake provider never queries, so nothing here reaches the database. */
const run = effectRunner(ManagedRuntime.make(noDatabase));

const PROVIDER_ID = "0199a3a0-0000-7000-8000-000000000001";

const activity: ModelRequests.Activity = {
	purpose: "agent-turn",
	podId: "0199a3a0-0000-7000-8000-000000000002",
	agentId: "0199a3a0-0000-7000-8000-000000000003",
	threadId: "0199a3a0-0000-7000-8000-000000000004",
	turnId: "0199a3a0-0000-7000-8000-000000000005",
};

/** An OpenAI chat completion, streamed as the API streams one. */
function streamed(
	delta: Record<string, unknown>,
	finishReason: string,
	usage: { prompt_tokens: number; completion_tokens: number },
): Response {
	const chunk = (fields: Record<string, unknown>) =>
		`data: ${JSON.stringify({ id: "response-1", object: "chat.completion.chunk", created: 0, model: "gpt-test", ...fields })}\n\n`;
	const body = [
		chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] }),
		chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
		chunk({
			choices: [],
			usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
		}),
		"data: [DONE]\n\n",
	].join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const toolCall = () =>
	streamed(
		{
			tool_calls: [
				{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
			],
		},
		"tool_calls",
		{ prompt_tokens: 1_000, completion_tokens: 20 },
	);
const reply = () =>
	streamed({ content: "Found it." }, "stop", { prompt_tokens: 1_200, completion_tokens: 10 });

/** A request as the ledger has it: its start, and its ending once it has one. */
type Recorded = ModelRequests.Started &
	Partial<Omit<ModelRequests.Ending, "outcome">> & { outcome: ModelRequests.Outcome };

const OPENAI = {
	preset: "openai",
	baseUrl: "https://api.openai.com/v1",
	apiFormat: "openai",
} satisfies ProviderIdentity;

/** A model over `provider`, OpenAI's unless given, that answers with `responses`, one per request. */
function modelAnswering(
	responses: Array<(recorded: readonly Recorded[]) => Response>,
	provider: ProviderIdentity = OPENAI,
) {
	const recorded: Recorded[] = [];
	/** Each request's body, as the provider was sent it. */
	const sent: Array<Record<string, unknown>> = [];
	/** Each request's URL, and the base URL its client was bound to. */
	const addressed: Array<{ url: string; boundTo: string }> = [];
	const answers = [...responses];
	const model = Models.make({
		modelProviders: {
			renewOAuthTokens: () => Effect.die(new Error("Not a ChatGPT provider")),
			resolve: () =>
				Effect.succeed(
					resolvedModel({
						providerId: PROVIDER_ID,
						...provider,
						apiKey: "secret",
						headers: {},
						configurationUpdatedAt: new Date(0),
					}),
				),
		},
		httpClients: {
			for: (endpoint) => async (url, init) => {
				addressed.push({ url: String(url), boundTo: endpoint.baseUrl });
				sent.push(JSON.parse(String(init?.body)));
				return answers.shift()?.(recorded) ?? new Response("No more answers", { status: 500 });
			},
		},
		requests: {
			start: (request) =>
				Effect.sync(() => String(recorded.push({ ...request, outcome: "started" }) - 1)),
			finish: (id, ending) =>
				Effect.sync(() => {
					Object.assign(recorded[Number(id)] ?? {}, ending);
				}),
		},
		registry: { version: "models.dev@test", cost: () => ({ input: 3, output: 15 }) },
	});
	return { model, recorded, sent, addressed };
}

const input: Models.StreamRequest = {
	workspaceId: "0199a3a0-0000-7000-8000-000000000006",
	activity,
	model: "gpt-test",
	system: "You are a test.",
	messages: [{ role: "user", content: "Look it up." }],
	tools: {
		lookup: tool({
			description: "Looks it up.",
			inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
			execute: async () => "It is here.",
		}),
	},
	maxSteps: 8,
};

/** Reads the whole response: its text, and how it ended. */
const answer = (model: ReturnType<typeof modelAnswering>["model"], request = input) =>
	run(
		Effect.scoped(
			Effect.gen(function* () {
				const generated = yield* model.stream(request);
				let text = "";
				yield* Models.forEachDelta(generated.text, (delta) =>
					Effect.sync(() => {
						text += delta;
					}),
				);
				return { text, finished: yield* Effect.exit(generated.finished) };
			}),
		),
	);

describe("recording model requests", () => {
	it("records each request a turn makes, with what it used and what it cost", async () => {
		const { model, recorded } = modelAnswering([toolCall, reply]);

		await answer(model);

		expect(recorded).toMatchObject([
			{
				workspaceId: input.workspaceId,
				activity,
				step: 0,
				providerId: PROVIDER_ID,
				preset: "openai",
				model: "gpt-test",
				outcome: "completed",
				usage: { inputTokens: 1_000, outputTokens: 20 },
				cost: { source: "models.dev@test" },
			},
			{
				step: 1,
				outcome: "completed",
				usage: { inputTokens: 1_200, outputTokens: 10 },
			},
		]);
		expect(recorded[0]?.cost?.usd).toBeCloseTo((1_000 * 3 + 20 * 15) / 1_000_000);
		expect(recorded.map((request) => request.endedAt)).toEqual([
			expect.any(Date),
			expect.any(Date),
		]);
	});

	it("records a request the provider refused as failed, with nothing used or charged", async () => {
		const { model, recorded } = modelAnswering([
			() => Response.json({ error: { message: "No credit" } }, { status: 402 }),
		]);

		await answer(model);

		expect(recorded).toEqual([
			expect.objectContaining({ step: 0, outcome: "failed", usage: undefined, cost: undefined }),
		]);
	});

	it("records a request before it is sent, so one the process never saw end is still counted", async () => {
		let seenByProvider: ModelRequests.Outcome[] = [];
		const { model } = modelAnswering([
			(recorded) => {
				seenByProvider = recorded.map((request) => request.outcome);
				return reply();
			},
		]);

		await answer(model);

		expect(seenByProvider).toEqual(["started"]);
	});
});

describe("a rate-limited provider", () => {
	const rateLimited = (headers: Record<string, string>) => () =>
		Response.json({ error: { message: "Slow down" } }, { status: 429, headers });

	it("is asked again after the short wait it asks for, and the reply goes on", async () => {
		const { model, sent } = modelAnswering([rateLimited({ "retry-after-ms": "1" }), reply]);

		const { text, finished } = await answer(model);

		expect(text).toBe("Found it.");
		expect(finished._tag).toBe("Success");
		expect(sent).toHaveLength(2);
	});

	it("is not asked again when it asks for a longer wait than we give it", async () => {
		const { model, sent } = modelAnswering([rateLimited({ "retry-after": "120" }), reply]);

		const { finished } = await answer(model);

		expect(finished).toMatchObject({ _tag: "Failure" });
		expect(sent).toHaveLength(1);
	});

	it("stops waiting when the request is aborted, and records it as aborted", async () => {
		const { model, recorded, sent } = modelAnswering([rateLimited({ "retry-after": "30" }), reply]);

		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const generated = yield* model.stream(input);
					yield* Models.forEachDelta(generated.text, () => Effect.void);
				}),
			).pipe(Effect.timeoutOption("50 millis")),
		);

		expect(sent).toHaveLength(1);
		await vi.waitFor(() => expect(recorded).toMatchObject([{ outcome: "aborted" }]));
	});
});

describe("a response at its step limit", () => {
	it("tells its last model call to answer, changing nothing earlier calls sent", async () => {
		const { model, sent } = modelAnswering([toolCall, reply]);

		const { text } = await answer(model, { ...input, maxSteps: 2 });

		expect(text).toBe("Found it.");
		expect(sent).toHaveLength(2);
		const [first = {}, last = {}] = sent;
		expect(last.tools).toEqual(first.tools);
		expect(last.tool_choice).toEqual(first.tool_choice);
		expect(last.messages).toEqual([
			...(first.messages as unknown[]),
			expect.objectContaining({ role: "assistant" }),
			{
				role: "tool",
				tool_call_id: "call-1",
				content: expect.stringMatching(/^It is here\.\n\n\(This is your last step/),
			},
		]);
	});
});

describe("images a tool returns", () => {
	it("reach a model through OpenRouter in a message after the tool's result", async () => {
		const { model, sent } = modelAnswering([toolCall, reply], {
			preset: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiFormat: "openai",
		});
		const showing = tool({
			description: "Looks it up.",
			inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
			execute: async () => ({
				text: "The image chart.png.",
				images: [{ data: "iVBORw0KGgo=", mediaType: "image/png" }],
			}),
			toModelOutput: ({ output }) => withImages(output, true),
		});

		await answer(model, { ...input, model: "google/gemini-test", tools: { lookup: showing } });

		const [, second = {}] = sent;
		expect((second.messages as unknown[]).slice(-2)).toEqual([
			{
				role: "tool",
				tool_call_id: "call-1",
				name: "lookup",
				content: [
					{ type: "text", text: "The image chart.png." },
					{ type: "text", text: IMAGE_MOVED_NOTE },
				],
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "What lookup returned:" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
				],
			},
		]);
	});
});

describe("prompt caching", () => {
	const marked = { type: "ephemeral" };
	const turn: Models.StreamRequest = {
		...input,
		messages: [
			{ role: "user", content: "Earlier." },
			{ role: "assistant", content: "Noted.", cacheBreakpoint: true },
			{ role: "user", content: "[Turn] Look it up." },
		],
	};

	/** Which of a request's messages are marked, on the message or on one of its parts. */
	const markedMessages = (body: Record<string, unknown> = {}) =>
		(body.messages as Array<{ content: unknown; cache_control?: unknown }>).map(
			(message) =>
				message.cache_control !== undefined ||
				(Array.isArray(message.content) &&
					message.content.some((part) => part.cache_control !== undefined)),
		);

	it("marks the system text, the history's end and each step's newest message for Anthropic", async () => {
		const { model, sent } = modelAnswering([() => new Response("Unavailable", { status: 503 })], {
			preset: "anthropic",
			baseUrl: "https://api.anthropic.com",
			apiFormat: "anthropic",
		});

		await answer(model, { ...turn, model: "claude-test" });

		expect(sent[0]).toMatchObject({
			system: [{ text: input.system, cache_control: marked }],
			messages: [
				{ role: "user", content: [{ text: "Earlier." }] },
				{ role: "assistant", content: [{ text: "Noted.", cache_control: marked }] },
				{ role: "user", content: [{ text: "[Turn] Look it up.", cache_control: marked }] },
			],
		});
	});

	it("moves the newest message's mark on each step, keeping the history's", async () => {
		const { model, sent } = modelAnswering([toolCall, reply], {
			preset: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiFormat: "openai",
		});

		await answer(model, { ...turn, model: "anthropic/claude-test" });

		// System text, history, turn.
		expect(markedMessages(sent[0])).toEqual([true, false, true, true]);
		// The turn's mark has moved to the tool result.
		expect(markedMessages(sent[1])).toEqual([true, false, true, false, false, true]);
	});

	it("marks only the last of several tool results, keeping within Anthropic's four marks", async () => {
		const parallelToolCalls = () =>
			streamed(
				{
					tool_calls: ["call-1", "call-2", "call-3"].map((id, index) => ({
						index,
						id,
						type: "function",
						function: { name: "lookup", arguments: "{}" },
					})),
				},
				"tool_calls",
				{ prompt_tokens: 1_000, completion_tokens: 20 },
			);
		const { model, sent } = modelAnswering([parallelToolCalls, reply], {
			preset: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiFormat: "openai",
		});

		await answer(model, { ...turn, model: "anthropic/claude-test" });

		// System text, history, turn, the tool calls, then one message per result.
		expect(markedMessages(sent[1])).toEqual([true, false, true, false, false, false, false, true]);
	});

	it.each([
		["OpenAI", OPENAI, "gpt-test"],
		[
			"OpenRouter's other models",
			{ preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" },
			"openai/gpt-test",
		],
	] satisfies Array<[string, ProviderIdentity, string]>)(
		"leaves requests to %s unmarked, since they cache by themselves",
		async (_name, provider, modelId) => {
			const { model, sent } = modelAnswering([toolCall, reply], provider);

			await answer(model, { ...turn, model: modelId });

			expect(JSON.stringify(sent)).not.toContain("cache_control");
		},
	);
});

describe("Gemini", () => {
	const GEMINI = {
		preset: "gemini",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		apiFormat: "openai",
	} satisfies ProviderIdentity;

	/** A response in the native Gemini API's stream format. */
	const geminiStreamed = (parts: unknown[]) =>
		new Response(
			`data: ${JSON.stringify({
				candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
				usageMetadata: {
					promptTokenCount: 1_000,
					candidatesTokenCount: 20,
					totalTokenCount: 1_020,
				},
			})}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);

	it("hands a tool call's thought signature back, as Gemini requires", async () => {
		const { model, sent, addressed } = modelAnswering(
			[
				() =>
					geminiStreamed([
						{ functionCall: { name: "lookup", args: {} }, thoughtSignature: "signature-1" },
					]),
				() => geminiStreamed([{ text: "Found it." }]),
			],
			GEMINI,
		);

		const { text, finished } = await answer(model, { ...input, model: "gemini-test" });

		expect(finished._tag).toBe("Success");
		expect(text).toBe("Found it.");
		expect(addressed).toEqual([
			{
				url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
				boundTo: "https://generativelanguage.googleapis.com/v1beta",
			},
			expect.objectContaining({ boundTo: "https://generativelanguage.googleapis.com/v1beta" }),
		]);
		expect(sent[1]?.contents).toContainEqual({
			role: "model",
			parts: [expect.objectContaining({ thoughtSignature: "signature-1" })],
		});
	});

	it("asks a Gemma model, listed under models/, with its system text in the prompt", async () => {
		const { model, sent, addressed } = modelAnswering(
			[() => geminiStreamed([{ text: "Hello." }])],
			GEMINI,
		);

		await answer(model, { ...input, model: "models/gemma-test", tools: {} });

		expect(addressed[0]?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemma-test:streamGenerateContent?alt=sse",
		);
		expect(sent[0]).not.toHaveProperty("systemInstruction");
		expect(JSON.stringify(sent[0]?.contents)).toContain("You are a test.");
	});
});

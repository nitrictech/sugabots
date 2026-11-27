import type { ProviderModelCapability } from "@sugabots/contracts";
import { jsonSchema, type ToolResultPart, type ToolSet, tool } from "ai";
import { Cause, Clock, Duration, Effect, Exit, Fiber, ManagedRuntime, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ModelRequests } from "../../accounting/model-requests.ts";
import { seedMember, seedWorkspace } from "../../authentication/seed.test-support.ts";
import { withImages } from "../../chats/tools/images.ts";
import { effectRunner } from "../../database/database.ts";
import { providerModel } from "../../database/schema.ts";
import { noDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import type { ProviderIdentity } from "../model-providers/dialects/index.ts";
import { IMAGE_MOVED_NOTE } from "../model-providers/dialects/tool-images.ts";
import { ModelProviderStore } from "../model-providers/model-provider-store.ts";
import { Models } from "./models.ts";
import { resolvedModel } from "./testing.ts";

/** The fake provider never queries, so nothing here reaches the database. */
const run = effectRunner(ManagedRuntime.make(noDatabase));

const PROVIDER_ID = "0199a3a0-0000-7000-8000-000000000001";

const purpose: ModelRequests.RequestPurpose = {
	name: "bot-turn",
	botId: "0199a3a0-0000-7000-8000-000000000003",
	chatId: "0199a3a0-0000-7000-8000-000000000004",
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
	builtIn: "openai",
	baseUrl: "https://api.openai.com/v1",
	apiFormat: "openai",
} satisfies ProviderIdentity;

/** A model over `provider`, OpenAI's unless given, that answers with `responses`, one per request. */
function modelAnswering(
	responses: Array<(recorded: readonly Recorded[]) => Response>,
	provider: ProviderIdentity = OPENAI,
	capabilities: readonly ProviderModelCapability[] = [],
	resolve?: ModelProviderStore.Interface["resolve"],
	renewOAuthTokens: ModelProviderStore.Interface["renewOAuthTokens"] = () =>
		Effect.die(new Error("Not a ChatGPT provider")),
) {
	const recorded: Recorded[] = [];
	/** Each request's body, as the provider was sent it. */
	const sent: Array<Record<string, unknown>> = [];
	/** Each request's URL, and the base URL its client was bound to. */
	const addressed: Array<{ url: string; boundTo: string }> = [];
	/** Each request's headers, by lower-case name. */
	const headers: Array<Record<string, string>> = [];
	const answers = [...responses];
	const model = Models.fromParts({
		modelProviders: {
			renewOAuthTokens,
			resolve:
				resolve ??
				(() =>
					Effect.succeed(
						resolvedModel(
							{
								providerId: PROVIDER_ID,
								...provider,
								apiKey: "secret",
								headers: {},
								configurationRevision: 0,
							},
							capabilities,
						),
					)),
		},
		httpClients: {
			for: (endpoint) => async (url, init) => {
				addressed.push({ url: String(url), boundTo: endpoint.baseUrl });
				headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
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
	return { model, recorded, sent, addressed, headers };
}

const input: Models.StreamRequest = {
	workspaceId: "0199a3a0-0000-7000-8000-000000000006",
	purpose,
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
};

/** Reads the whole response: its text, and how it ended, on `clock` unless it is left to the real one. */
const answer = (
	model: ReturnType<typeof modelAnswering>["model"],
	request = input,
	clock?: Clock.Clock,
) =>
	run(
		Effect.scoped(
			Effect.gen(function* () {
				const generated = yield* model.stream(request);
				let text = "";
				yield* Models.forEachDelta(generated.deltas, (delta) =>
					Effect.sync(() => {
						text += delta.kind === "text" ? delta.text : "";
					}),
				);
				return { text, finished: yield* Effect.exit(generated.finished) };
			}),
		).pipe((answered) => (clock ? Effect.provideService(answered, Clock.Clock, clock) : answered)),
	);

/**
 * A clock whose sleeps last until `wake`, so a case sees how long it was
 * asked to wait and acts while it waits. `nextSleep` resolves with the
 * milliseconds of the first sleep.
 */
function sleepsUntilWoken() {
	const woken = Promise.withResolvers<void>();
	const asked = Promise.withResolvers<number>();
	const cancelled = Promise.withResolvers<void>();
	const live = Effect.runSync(Clock.clockWith(Effect.succeed));
	const clock: Clock.Clock = Object.create(live, {
		sleep: {
			value: (duration: Duration.Duration) =>
				Effect.callback<void>((resume) => {
					asked.resolve(Duration.toMillis(duration));
					void woken.promise.then(() => resume(Effect.void));
					return Effect.sync(() => cancelled.resolve());
				}),
		},
	});
	/** Resolves once something sleeps, as the case's own effect can wait on. */
	const sleeping = Effect.callback<number>((resume) => {
		void asked.promise.then((milliseconds) => resume(Effect.succeed(milliseconds)));
	});
	return {
		clock,
		nextSleep: asked.promise,
		sleeping,
		/** Resolves once the sleep is given up on, rather than woken. */
		cancelled: cancelled.promise,
		wake: () => woken.resolve(),
	};
}

/**
 * Makes a turn's two steps' requests as the bot loop does: the first, offered
 * the tools with nothing to run them with; then each tool call it made, from
 * `request.tools`; then the second request, continuing from the first's
 * answer and the calls' results, told it is the last when `lastStep` says so.
 * Returns how the second ended.
 */
async function answerAsTheLoop(
	model: ReturnType<typeof modelAnswering>["model"],
	request: Models.StreamRequest = input,
	{ lastStep = false }: { lastStep?: boolean } = {},
) {
	const tools = request.tools ?? {};
	const offered: ToolSet = Object.fromEntries(
		Object.entries(tools).map(([name, { execute: _runsHere, ...definition }]) => [
			name,
			definition,
		]),
	);
	const first = await run(
		Effect.scoped(
			Effect.gen(function* () {
				const generated = yield* model.stream({ ...request, tools: offered, step: 0 });
				yield* Models.forEachDelta(generated.deltas, () => Effect.void);
				return yield* generated.finished;
			}),
		),
	);
	const results = await Promise.all(
		first.toolCalls.map(async (call): Promise<ToolResultPart> => {
			const called = tools[call.toolName];
			const output: unknown = await called?.execute?.(
				call.input as never,
				{
					toolCallId: call.toolCallId,
					messages: [],
				} as never,
			);
			return {
				type: "tool-result",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				output: called?.toModelOutput
					? await called.toModelOutput({
							toolCallId: call.toolCallId,
							input: call.input as never,
							output: output as never,
						})
					: typeof output === "string"
						? { type: "text", value: output }
						: { type: "json", value: output as never },
			};
		}),
	);
	return answer(model, {
		...request,
		tools: offered,
		step: 1,
		lastRequest: lastStep,
		continuationMessages: [...first.responseMessages, { role: "tool", content: results }],
	});
}

describe("the request a provider is sent", () => {
	const KEY = "secret";
	const customHeaders = { "x-workspace": "workspace" };
	const resolvingTo =
		(access: Omit<ModelProviderStore.ProviderAccess, "providerId" | "configurationRevision">) =>
		() =>
			Effect.succeed(
				resolvedModel({ providerId: PROVIDER_ID, ...access, configurationRevision: 0 }),
			);

	it.each([
		{
			name: "an OpenAI-format provider whose address ends in a slash",
			apiFormat: "openai",
			baseUrl: "https://models.example/v1/",
			boundTo: "https://models.example/v1",
			url: "https://models.example/v1/chat/completions",
			authorization: { authorization: `Bearer ${KEY}` },
		},
		{
			name: "an Anthropic-format provider at a bare host",
			apiFormat: "anthropic",
			baseUrl: "https://models.example",
			boundTo: "https://models.example/v1",
			url: "https://models.example/v1/messages",
			authorization: { "x-api-key": KEY },
		},
		{
			name: "an Anthropic-format provider whose address ends in /v1/",
			apiFormat: "anthropic",
			baseUrl: "https://models.example/v1/",
			boundTo: "https://models.example/v1",
			url: "https://models.example/v1/messages",
			authorization: { "x-api-key": KEY },
		},
	] as const)(
		"goes through the provider's own client to $url, with its key and headers, for $name",
		async ({ apiFormat, baseUrl, boundTo, url, authorization }) => {
			const { model, addressed, headers } = modelAnswering(
				[],
				OPENAI,
				[],
				resolvingTo({
					builtIn: null,
					baseUrl,
					apiFormat,
					apiKey: KEY,
					headers: customHeaders,
				}),
			);

			await answer(model);

			expect(addressed).toEqual([{ url, boundTo }]);
			expect(headers[0]).toMatchObject({ ...authorization, ...customHeaders });
		},
	);

	it("asks the Codex backend with a ChatGPT subscription's access token and account", async () => {
		const tokens = {
			access: "access-token",
			refresh: "refresh-token",
			expiresAt: Date.now() + 60 * 60_000,
			accountId: "account-1",
		};
		const { model, addressed, headers } = modelAnswering(
			[],
			OPENAI,
			[],
			resolvingTo({
				builtIn: "chatgpt",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				apiFormat: "openai",
				headers: {},
				oauthTokens: tokens,
			}),
			// Fresh, so nothing refreshes them.
			() => Effect.succeed(tokens),
		);

		await answer(model, { ...input, model: "gpt-5.5" });

		expect(addressed[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(headers[0]).toMatchObject({
			authorization: "Bearer access-token",
			"chatgpt-account-id": "account-1",
		});
	});
});

describe("recording model requests", () => {
	it("records each request a turn makes, as the step it is, with what it used and what it cost", async () => {
		const { model, recorded } = modelAnswering([toolCall, reply]);

		await answerAsTheLoop(model);

		expect(recorded).toMatchObject([
			{
				workspaceId: input.workspaceId,
				purpose,
				step: 0,
				providerId: PROVIDER_ID,
				builtIn: "openai",
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

	it("is asked again only once the wait it asks for has passed, and the reply goes on", async () => {
		const { model, sent } = modelAnswering([rateLimited({ "retry-after-ms": "30000" }), reply]);
		const waiting = sleepsUntilWoken();
		const answering = answer(model, input, waiting.clock);

		const first = await Promise.race([waiting.nextSleep, answering]);
		const askedWhileWaiting = sent.length;
		waiting.wake();
		const { text, finished } = await answering;

		expect(first).toBe(30_000);
		expect(askedWhileWaiting).toBe(1);
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
		const waiting = sleepsUntilWoken();

		await run(
			Effect.gen(function* () {
				const consuming = yield* Effect.forkChild(
					Effect.scoped(
						Effect.gen(function* () {
							const generated = yield* model.stream(input);
							yield* Models.forEachDelta(generated.deltas, () => Effect.void);
						}),
					).pipe(Effect.provideService(Clock.Clock, waiting.clock)),
				);
				yield* waiting.sleeping;
				yield* Fiber.interrupt(consuming);
			}),
		);

		await waiting.cancelled;
		expect(sent).toHaveLength(1);
		await vi.waitFor(() => expect(recorded).toMatchObject([{ outcome: "aborted" }]));
	});
});

describe("a turn's last step", () => {
	it("tells its model request to answer, changing nothing earlier requests sent", async () => {
		const { model, sent } = modelAnswering([toolCall, reply]);

		const { text } = await answerAsTheLoop(model, input, { lastStep: true });

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
			builtIn: "openrouter",
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

		await answerAsTheLoop(model, {
			...input,
			model: "google/gemini-test",
			tools: { lookup: showing },
		});

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
			builtIn: "anthropic",
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
			builtIn: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiFormat: "openai",
		});

		await answerAsTheLoop(model, { ...turn, model: "anthropic/claude-test" });

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
			builtIn: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiFormat: "openai",
		});

		await answerAsTheLoop(model, { ...turn, model: "anthropic/claude-test" });

		// System text, history, turn, the tool calls, then one message per result.
		expect(markedMessages(sent[1])).toEqual([true, false, true, false, false, false, false, true]);
	});

	it.each([
		["OpenAI", OPENAI, "gpt-test"],
		[
			"OpenRouter's other models",
			{ builtIn: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" },
			"openai/gpt-test",
		],
	] satisfies Array<[string, ProviderIdentity, string]>)(
		"leaves requests to %s unmarked, since they cache by themselves",
		async (_name, provider, modelId) => {
			const { model, sent } = modelAnswering([toolCall, reply], provider);

			await answerAsTheLoop(model, { ...turn, model: modelId });

			expect(JSON.stringify(sent)).not.toContain("cache_control");
		},
	);
});

describe("thinking options", () => {
	const ANTHROPIC = {
		builtIn: "anthropic",
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
	} satisfies ProviderIdentity;
	const refused = () => new Response("Unavailable", { status: 503 });

	it.each(["claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-haiku", "claude-unknown"])(
		"sends no thinking options to %s",
		async (modelId) => {
			const { model, sent } = modelAnswering([refused], ANTHROPIC, ["thinking"]);
			await answer(model, { ...input, model: modelId });
			expect(sent[0]).toBeDefined();
			expect(sent[0]).not.toHaveProperty("thinking");
		},
	);

	it("asks for adaptive thinking and replays an unchanged signed Claude block", async () => {
		const { model, sent } = modelAnswering([refused], ANTHROPIC, ["thinking"]);
		const block = { type: "thinking", thinking: "Check this first.", signature: "opaque-clause" };
		await answer(model, {
			...input,
			model: "claude-sonnet-4-6",
			continuationMessages: [
				{
					role: "assistant",
					content: [
						{
							type: "reasoning",
							text: block.thinking,
							providerOptions: { anthropic: { signature: block.signature } },
						},
						{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} },
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call-1",
							toolName: "lookup",
							output: { type: "text", value: "Found." },
						},
					],
				},
			],
		});
		expect(sent[0]).toMatchObject({
			thinking: { type: "adaptive", display: "summarized" },
			messages: expect.arrayContaining([
				{
					role: "assistant",
					content: [block, expect.objectContaining({ type: "tool_use", id: "call-1" })],
				},
			]),
		});
	});

	it("asks OpenAI for a visible summary and replays the opaque item using Responses", async () => {
		const { model, sent, addressed } = modelAnswering([refused], OPENAI, ["thinking"]);
		await answer(model, {
			...input,
			model: "o4-mini",
			continuationMessages: [
				{
					role: "assistant",
					content: [
						{
							type: "reasoning",
							text: "Check this first.",
							providerOptions: {
								openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" },
							},
						},
					],
				},
			],
		});
		expect(addressed[0]?.url).toBe("https://api.openai.com/v1/responses");
		expect(sent[0]).toMatchObject({
			store: false,
			reasoning: { summary: "auto" },
			input: expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", id: "rs_1", encrypted_content: "encrypted" }),
			]),
		});
		expect(sent[0]?.reasoning).not.toHaveProperty("effort");
	});

	it("asks OpenRouter for its default thinking budget", async () => {
		const { model, sent } = modelAnswering(
			[reply],
			{
				builtIn: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				apiFormat: "openai",
			},
			["thinking"],
		);
		await answer(model, { ...input, model: "openai/o4-mini" });
		expect(sent[0]?.reasoning).toEqual({ enabled: true });
	});
});

const responsesSse = (...events: Record<string, unknown>[]) =>
	new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});

const responsesReply = () =>
	responsesSse(
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Found it." },
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
		{ type: "response.completed", response: {} },
	);

const unsupportedResponsesParameter = (param: string) => () =>
	Response.json(
		{
			error: {
				message: "The request cannot use this parameter.",
				type: "invalid_request_error",
				code: "unsupported_value",
				param,
			},
		},
		{ status: 400 },
	);

describe("recorded thinking paths", () => {
	it("answers after retrying a Responses summary refusal once without the summary", async () => {
		const { model, sent, recorded } = modelAnswering(
			[unsupportedResponsesParameter("reasoning.summary"), responsesReply],
			OPENAI,
			["thinking"],
		);

		const { text, finished } = await answer(model, { ...input, model: "o4-mini" });

		expect(text).toBe("Found it.");
		expect(finished._tag).toBe("Success");
		expect(sent).toHaveLength(2);
		expect(sent[0]?.reasoning).toMatchObject({ summary: "auto" });
		expect(sent[1]).not.toHaveProperty("reasoning.summary");
		expect(sent[1]).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] });
		expect(recorded.map(({ outcome }) => outcome)).toEqual(["completed"]);
	});

	it.each([
		["reasoning.summary", 2],
		["max_output_tokens", 1],
	] as const)("limits Responses retries when %s is refused", async (param, attempts) => {
		const refusal = unsupportedResponsesParameter(param);
		const { model, sent } = modelAnswering([refusal, refusal, responsesReply], OPENAI, [
			"thinking",
		]);
		const { finished } = await answer(model, { ...input, model: "o4-mini" });
		if (Exit.isSuccess(finished)) throw new Error("The provider refused this request");
		expect(Option.getOrUndefined(Cause.findErrorOption(finished.cause))).toBeInstanceOf(
			Models.ProviderRejectedRequest,
		);
		expect(sent).toHaveLength(attempts);
	});

	it("classifies a Responses failure from its nested error code", async () => {
		const { model } = modelAnswering(
			[
				() =>
					responsesSse({
						type: "response.failed",
						sequence_number: 1,
						response: { error: { code: "context_length_exceeded", message: "Input too large." } },
					}),
			],
			OPENAI,
			["thinking"],
		);

		const { finished } = await answer(model, { ...input, model: "o4-mini" });

		if (Exit.isSuccess(finished)) throw new Error("Responses accepted oversized input");
		expect(Option.getOrUndefined(Cause.findErrorOption(finished.cause))).toBeInstanceOf(
			Models.ProviderContextLengthExceeded,
		);
	});

	it("keeps non-thinking OpenAI models on Chat Completions", async () => {
		const { model, sent, addressed } = modelAnswering([reply]);
		const { text, finished } = await answer(model, { ...input, model: "gpt-4.1" });
		expect(finished._tag).toBe("Success");
		expect(text).toBe("Found it.");
		expect(addressed[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(sent[0]).not.toHaveProperty("reasoning");
	});

	it("sends ChatGPT the system text only as its instructions, with stateless options and its thinking summary", async () => {
		const { model, sent, addressed } = modelAnswering(
			[responsesReply],
			{
				builtIn: "chatgpt",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				apiFormat: "openai",
			},
			["thinking"],
		);

		const { text, finished } = await answer(model, { ...input, model: "gpt-5-codex" });

		expect(text).toBe("Found it.");
		expect(finished._tag).toBe("Success");
		expect(addressed[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(sent[0]).toMatchObject({
			instructions: input.system,
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { summary: "auto" },
		});
		// The system text goes once, as `instructions`: not again as a system or developer message.
		const sentInput = sent[0]?.input as Array<{ role?: string }> | undefined;
		expect(sentInput?.map(({ role }) => role)).toEqual(["user"]);
	});

	const withLookup = (delta: Record<string, unknown>) => () =>
		streamed(
			{
				...delta,
				tool_calls: [
					{
						index: 0,
						id: "call-1",
						type: "function",
						function: { name: "lookup", arguments: "{}" },
					},
				],
			},
			"tool_calls",
			{ prompt_tokens: 100, completion_tokens: 20 },
		);

	it("replays thinking as reasoning_content beside the OpenAI-compatible tool call", async () => {
		const { model, sent } = modelAnswering(
			[withLookup({ reasoning_content: "Look up the record." }), reply],
			{ builtIn: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiFormat: "openai" },
			["thinking"],
		);

		const { text, finished } = await answerAsTheLoop(model, {
			...input,
			model: "deepseek-reasoner",
		});

		expect(finished._tag).toBe("Success");
		expect(text).toBe("Found it.");
		expect(sent[1]?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					reasoning_content: "Look up the record.",
					tool_calls: [expect.objectContaining({ id: "call-1" })],
				}),
				expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: "It is here." }),
			]),
		);
	});

	it("replays OpenRouter's signed reasoning_details beside the tool call", async () => {
		const detail = {
			type: "reasoning.text",
			text: "Look up the record.",
			signature: "signature-1",
			format: "anthropic-claude-v1",
			index: 0,
		};
		const { model, sent } = modelAnswering(
			[withLookup({ reasoning_details: [detail] }), reply],
			{ builtIn: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" },
			["thinking"],
		);

		const { text, finished } = await answerAsTheLoop(model, {
			...input,
			model: "anthropic/claude-sonnet-4.6",
		});

		expect(finished._tag).toBe("Success");
		expect(text).toBe("Found it.");
		expect(sent[1]?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					reasoning_details: [expect.objectContaining(detail)],
					tool_calls: [expect.objectContaining({ id: "call-1" })],
				}),
			]),
		);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("a workspace's per-model Thinking switch", () => {
	it.each([
		["anthropic", "claude-sonnet-4-6", "thinking"],
		["openai", "gpt-5", "reasoning"],
		["gemini", "gemini-2.5-flash", "generationConfig.thinkingConfig"],
	] as const)("honors disabledCapabilities for %s", async (builtIn, modelId, field) => {
		const store = await runOnPostgres(
			Effect.provide(ModelProviderStore.Service, ModelProviderStore.layer),
		);
		const workspaceId = await seedWorkspace();
		const memberId = await seedMember(workspaceId, "admin");
		const provider = await runOnPostgres(
			store.create(workspaceId, {
				createdById: memberId,
				provider: { builtIn, apiKey: "test-key" },
			}),
		);
		await runOnPostgres(store.update(workspaceId, provider.id, { active: true }, memberId));
		const [modelRow] = await onDatabase((db) =>
			db
				.insert(providerModel)
				.values({
					workspaceId,
					providerId: provider.id,
					modelId,
					source: "manual",
					capabilities: ["thinking"],
					enabled: true,
				})
				.returning({ id: providerModel.id }),
		);
		if (!modelRow) throw new Error("Failed to add the model");
		const providerUnavailable = () => new Response("Unavailable", { status: 503 });
		const { model, sent } = modelAnswering(
			[providerUnavailable, providerUnavailable],
			provider,
			[],
			store.resolve,
		);

		await answer(model, { ...input, workspaceId, model: modelId });
		await runOnPostgres(
			store.updateModel(workspaceId, provider.id, modelRow.id, {
				disabledCapabilities: ["thinking"],
			}),
		);
		await answer(model, { ...input, workspaceId, model: modelId });

		expect(sent).toHaveLength(2);
		expect(sent[0]).toHaveProperty(field);
		expect(sent[1]).not.toHaveProperty(field);
	});
});

describe("Gemini", () => {
	const GEMINI = {
		builtIn: "gemini",
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
						{ text: "Look it up first.", thought: true, thoughtSignature: "signature-thinking" },
						{ functionCall: { name: "lookup", args: {} }, thoughtSignature: "signature-1" },
					]),
				() => geminiStreamed([{ text: "Found it." }]),
			],
			GEMINI,
			["thinking"],
		);

		const { text, finished } = await answerAsTheLoop(model, {
			...input,
			model: "gemini-2.5-flash",
		});

		expect(finished._tag).toBe("Success");
		expect(text).toBe("Found it.");
		expect(addressed).toEqual([
			{
				url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
				boundTo: "https://generativelanguage.googleapis.com/v1beta",
			},
			expect.objectContaining({ boundTo: "https://generativelanguage.googleapis.com/v1beta" }),
		]);
		expect(sent[0]).toMatchObject({
			generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
		});
		expect(sent[1]?.contents).toContainEqual({
			role: "model",
			parts: [
				expect.objectContaining({
					text: "Look it up first.",
					thought: true,
					thoughtSignature: "signature-thinking",
				}),
				expect.objectContaining({ thoughtSignature: "signature-1" }),
			],
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

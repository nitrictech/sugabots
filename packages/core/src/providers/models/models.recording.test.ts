import { jsonSchema, tool } from "ai";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { ModelRequests } from "../../accounting/model-requests.ts";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import type { ProviderIdentity } from "../model-providers/dialects/index.ts";
import { Models } from "./models.ts";

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
	const answers = [...responses];
	const model = Models.make({
		modelProviders: {
			renewOAuthTokens: () => Effect.die(new Error("Not a ChatGPT provider")),
			resolve: () =>
				Effect.succeed({
					providerId: PROVIDER_ID,
					...provider,
					apiKey: "secret",
					headers: {},
					configurationUpdatedAt: new Date(0),
				}),
		},
		httpClients: {
			for: () => async (_url, init) => {
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
	return { model, recorded, sent };
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

		/** Which of a request's messages are marked, on the message or on one of its parts. */
		const markedMessages = (body: Record<string, unknown> = {}) =>
			(body.messages as Array<{ content: unknown; cache_control?: unknown }>).map(
				(message) =>
					message.cache_control !== undefined ||
					(Array.isArray(message.content) &&
						message.content.some((part) => part.cache_control !== undefined)),
			);
		// System text, history, turn.
		expect(markedMessages(sent[0])).toEqual([true, false, true, true]);
		// The turn's mark has moved to the tool result.
		expect(markedMessages(sent[1])).toEqual([true, false, true, false, false, true]);
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

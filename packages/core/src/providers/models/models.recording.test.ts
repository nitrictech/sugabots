import { jsonSchema, tool } from "ai";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { ModelRequests } from "../../accounting/model-requests.ts";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
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

/** Calls to `lookup` made all at once, one per id, from a prompt the provider counted as `promptTokens`. */
const toolCallsAs = (ids: readonly string[], promptTokens: number) =>
	streamed(
		{
			tool_calls: ids.map((id, index) => ({
				index,
				id,
				type: "function",
				function: { name: "lookup", arguments: "{}" },
			})),
		},
		"tool_calls",
		{ prompt_tokens: promptTokens, completion_tokens: 20 },
	);
const toolCallAs = (id: string, promptTokens: number) => toolCallsAs([id], promptTokens);
const toolCall = () => toolCallAs("call-1", 1_000);
const reply = () =>
	streamed({ content: "Found it." }, "stop", { prompt_tokens: 1_200, completion_tokens: 10 });

/** A request as the ledger has it: its start, and its ending once it has one. */
type Recorded = ModelRequests.Started &
	Partial<Omit<ModelRequests.Ending, "outcome">> & { outcome: ModelRequests.Outcome };

/** A model over an OpenAI provider that answers with `responses`, one per request. */
function modelAnswering(responses: Array<(recorded: readonly Recorded[]) => Response>) {
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
					preset: "openai",
					baseUrl: "https://api.openai.com/v1",
					apiFormat: "openai",
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
	windowTokens: 100_000,
	maxSteps: 8,
};

/** Reads the whole response: its text, and how it ended. */
const answer = (
	model: ReturnType<typeof modelAnswering>["model"],
	request: Models.StreamRequest = input,
) =>
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

/** `input` whose `lookup` tool returns `result`, read by a model with a window of `windowTokens`. */
function lookingUp(result: string, windowTokens = 100_000): Models.StreamRequest {
	return {
		...input,
		windowTokens,
		tools: {
			lookup: tool({
				description: "Looks it up.",
				inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
				execute: async () => result,
			}),
		},
	};
}

/** The tool results in a request the provider was sent, by tool call. */
function toolResults(request: Record<string, unknown> | undefined): Record<string, string> {
	const messages = (request?.messages ?? []) as Array<{
		role: string;
		tool_call_id?: string;
		content?: string;
	}>;
	return Object.fromEntries(
		messages
			.filter((message) => message.role === "tool")
			.map((message) => [message.tool_call_id, message.content ?? ""]),
	);
}

describe("what a response's tools return", () => {
	it("reaches the model whole when it fits", async () => {
		const { model, sent } = modelAnswering([toolCall, reply]);

		await answer(model, lookingUp("It is here."));

		expect(toolResults(sent[1])).toEqual({ "call-1": "It is here." });
	});

	it("reaches a model with a 128k window whole when it is as long as a web_fetch page", async () => {
		const page = "p".repeat(44_000);
		const { model, sent } = modelAnswering([toolCall, reply]);

		await answer(model, lookingUp(page, 128_000));

		expect(toolResults(sent[1])).toEqual({ "call-1": page });
	});

	it("leaves every model call of a response that fits as it was built", async () => {
		const result = "r".repeat(30_000);
		const { model, sent } = modelAnswering([
			() => toolCallAs("call-1", 1_000),
			() => toolCallAs("call-2", 11_000),
			reply,
		]);

		await answer(model, lookingUp(result));

		const [first = {}, second = {}, third = {}] = sent;
		const toolMessage = (id: string) => ({ role: "tool", tool_call_id: id, content: result });
		expect(second.messages).toEqual([
			...(first.messages as unknown[]),
			expect.objectContaining({ role: "assistant" }),
			toolMessage("call-1"),
		]);
		expect(third.messages).toEqual([
			...(second.messages as unknown[]),
			expect.objectContaining({ role: "assistant" }),
			toolMessage("call-2"),
		]);
	});

	it("is cut to its share of the window, keeping its start and end and saying it was cut", async () => {
		const result = `start ${"x".repeat(200_000)} end`;
		const { model, sent } = modelAnswering([toolCall, reply]);

		await answer(model, lookingUp(result));

		const cut = toolResults(sent[1])["call-1"] ?? "";
		expect(cut.length).toBeLessThan(result.length / 2);
		expect(cut).toMatch(/^start x/);
		expect(cut).toMatch(/x end$/);
		expect(cut).toContain(`This result was ${result.length} characters, too long to show whole`);
	});

	it("is cut once, and later model calls are sent the same cut", async () => {
		const result = "z".repeat(200_000);
		const { model, sent } = modelAnswering([
			() => toolCallAs("call-1", 1_000),
			() => toolCallAs("call-2", 12_000),
			reply,
		]);

		await answer(model, lookingUp(result));

		const firstCut = toolResults(sent[1])["call-1"];
		expect(firstCut).toContain(`This result was ${result.length} characters`);
		expect(toolResults(sent[2])["call-1"]).toBe(firstCut);
	});

	it("has its oldest results cleared once they fill the window, keeping every call", async () => {
		const result = "y".repeat(24_000);
		// The provider counts the prompt that asked for the fourth call as filling
		// most of the window, so the fifth would overflow it.
		const { model, sent } = modelAnswering([
			() => toolCallAs("call-1", 1_000),
			() => toolCallAs("call-2", 9_000),
			() => toolCallAs("call-3", 17_000),
			() => toolCallAs("call-4", 63_000),
			reply,
		]);

		const { text } = await answer(model, lookingUp(result));

		expect(text).toBe("Found it.");
		const last = sent.at(-1);
		expect(toolResults(last)).toEqual({
			"call-1": expect.stringMatching(/^\[This result was cleared/),
			"call-2": expect.stringMatching(/^\[This result was cleared/),
			"call-3": expect.stringMatching(/^\[This result was cleared/),
			"call-4": result,
		});
		const calls = ((last?.messages ?? []) as Array<{ tool_calls?: Array<{ id: string }> }>).flatMap(
			(message) => message.tool_calls?.map((call) => call.id) ?? [],
		);
		expect(calls).toEqual(["call-1", "call-2", "call-3", "call-4"]);
	});

	it("reaches the model before it can be cleared, and is cleared with others rather than alone", async () => {
		const result = "h".repeat(30_000);
		// The history alone fills most of the window, as it may before the
		// thread is compacted, so clearing can never get the prompt down far.
		// Each call's prompt grows by the result it was sent until the fourth
		// result would take it past the most the window should hold.
		const { model, sent } = modelAnswering([
			() => toolCallAs("call-1", 135_000),
			() => toolCallAs("call-2", 147_000),
			() => toolCallAs("call-3", 159_000),
			() => toolCallAs("call-4", 171_000),
			reply,
		]);

		await answer(model, lookingUp(result, 200_000));

		expect(toolResults(sent[1])).toEqual({ "call-1": result });
		expect(toolResults(sent[2])).toEqual({ "call-1": result, "call-2": result });
		expect(toolResults(sent[3])).toEqual({
			"call-1": result,
			"call-2": result,
			"call-3": result,
		});
		const cleared = expect.stringMatching(/^\[This result was cleared/);
		expect(toolResults(sent[4])).toEqual({
			"call-1": cleared,
			"call-2": cleared,
			"call-3": cleared,
			"call-4": result,
		});
	});

	it("shares what room is left between results it has not read, cutting rather than clearing them", async () => {
		const ids = ["call-1", "call-2", "call-3", "call-4", "call-5", "call-6"];
		const { model, sent } = modelAnswering([() => toolCallsAs(ids, 1_000), reply]);

		await answer(model, lookingUp("w".repeat(60_000)));

		const results = Object.values(toolResults(sent[1]));
		expect(results).toHaveLength(ids.length);
		for (const result of results) expect(result).toContain("too long to show whole");
		const promptLimitCharacters = 100_000 * 0.9 * 2.5;
		expect(results.join("").length).toBeLessThan(promptLimitCharacters);
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

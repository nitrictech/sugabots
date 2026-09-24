import { type AttemptLedger, reduceAttempt } from "@sugabots/accounting";
import { APICallError, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { modelAttempt, modelAttemptObservation } from "../../accounting/sql.ts";
import { modelAttemptStore } from "../../accounting/store.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";

const provider = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => ({ chat: () => provider.model }) }));

import { forEachDelta, workspaceTurnModel } from "./model.ts";

/** What a provider streams back to the SDK, one request's worth at a time. */
type LanguageModelV4StreamPart =
	Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
		? Part
		: never;

/**
 * What the ledger holds after a real `streamText` run through the workspace
 * model: the SDK is real, the provider behind it is scripted.
 */
describe.skipIf(!process.env.DATABASE_URL)("recording model requests, against Postgres", () => {
	const connectionId = crypto.randomUUID();
	const model = workspaceTurnModel({
		modelProviders: {
			resolve: () =>
				Effect.succeed({
					providerId: connectionId,
					preset: "openai",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					headers: {},
					configurationUpdatedAt: new Date(),
				}),
		},
		httpClients: { for: () => fetch },
		attempts: modelAttemptStore,
	});
	let threadId: string;

	afterAll(closeDatabase);
	beforeEach(() => {
		threadId = crypto.randomUUID();
	});

	const input = (stop: AbortController) => ({
		workspaceId: crypto.randomUUID(),
		activity: { kind: "facilitation" as const, threadId },
		model: "gpt-test",
		system: "",
		messages: [{ role: "user" as const, content: "Hello" }],
		tools: {
			look: tool({
				inputSchema: jsonSchema<object>({ type: "object" }),
				execute: async () => "seen",
			}),
		},
		signal: stop.signal,
	});

	/** Every attempt made for this test's thread, oldest first, as the package reads them. */
	const ledgers = async (): Promise<AttemptLedger[]> => {
		const attempts = await onDatabase((db) =>
			db
				.select()
				.from(modelAttempt)
				.where(eq(modelAttempt.threadId, threadId))
				.orderBy(asc(modelAttempt.startedAt)),
		);
		return Promise.all(
			attempts.map(async (attempt) => {
				const observations = await onDatabase((db) =>
					db
						.select({ observation: modelAttemptObservation.observation })
						.from(modelAttemptObservation)
						.where(eq(modelAttemptObservation.attemptId, attempt.attemptId)),
				);
				return Effect.runSync(
					reduceAttempt(
						attempt.intent,
						observations.map((row) => row.observation),
					),
				);
			}),
		);
	};

	const usageOf = (ledger: AttemptLedger | undefined) =>
		ledger?.observations.find((observation) => observation.payload.type === "usage")?.payload;

	it("records each request of a multi-step response on its own, with its own usage", async () => {
		provider.model = new MockLanguageModelV4({
			doStream: [
				{ stream: streamOf(toolCall(), finish("tool-calls", 100, 10)) },
				{ stream: streamOf(...text("Done"), finish("stop", 150, 20)) },
			],
		});
		const stop = new AbortController();

		await runOnPostgres(
			Effect.gen(function* () {
				const generated = yield* model.stream(input(stop));
				yield* forEachDelta(generated.text, stop, () => Effect.void);
			}),
		);

		const recorded = await ledgers();
		expect(recorded.map((ledger) => ledger.state)).toEqual(["succeeded", "succeeded"]);
		expect(recorded.map((ledger) => usageOf(ledger))).toMatchObject([
			{ evidence: { counters: { inputTokens: 100, outputTokens: 10 } } },
			{ evidence: { counters: { inputTokens: 150, outputTokens: 20 } } },
		]);
		expect(new Set(recorded.map((ledger) => ledger.intent.executionId)).size).toBe(1);
		expect(recorded[0]?.intent.attribution).toMatchObject({
			activityPurpose: "facilitation",
			threadId,
		});
	});

	it("keeps a finished request's usage when the response is stopped during the next", async () => {
		let hung: ReadableStreamDefaultController<LanguageModelV4StreamPart> | undefined;
		provider.model = new MockLanguageModelV4({
			doStream: [
				{ stream: streamOf(toolCall(), finish("tool-calls", 100, 10)) },
				{
					stream: new ReadableStream<LanguageModelV4StreamPart>({
						start(controller) {
							hung = controller;
							for (const part of text("Partial")) controller.enqueue(part);
						},
					}),
				},
			],
		});
		const stop = new AbortController();

		await runOnPostgres(
			Effect.gen(function* () {
				const generated = yield* model.stream(input(stop));
				yield* forEachDelta(generated.text, stop, () =>
					Effect.sync(() => {
						stop.abort();
						hung?.error(new DOMException("Aborted", "AbortError"));
					}),
				).pipe(Effect.ignore);
			}),
		);

		await vi.waitFor(async () => {
			expect((await ledgers()).map((ledger) => ledger.state)).toEqual(["succeeded", "cancelled"]);
		});
		const [finished] = await ledgers();
		expect(usageOf(finished)).toMatchObject({ evidence: { counters: { inputTokens: 100 } } });
	});

	it("records a request the provider refused as failed", async () => {
		provider.model = new MockLanguageModelV4({
			doStream: async () => {
				throw new APICallError({
					message: "Unauthorized",
					url: "https://models.example/v1/chat/completions",
					requestBodyValues: {},
					statusCode: 401,
					isRetryable: false,
				});
			},
		});
		const stop = new AbortController();

		await runOnPostgres(
			Effect.gen(function* () {
				const generated = yield* model.stream(input(stop));
				yield* forEachDelta(generated.text, stop, () => Effect.void);
			}).pipe(Effect.ignore),
		);

		await vi.waitFor(async () => {
			expect((await ledgers()).map((ledger) => ledger.state)).toEqual(["failed"]);
		});
	});
});

function streamOf(
	...parts: LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

function text(content: string): LanguageModelV4StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "text" },
		{ type: "text-delta", id: "text", delta: content },
		{ type: "text-end", id: "text" },
	];
}

function toolCall(): LanguageModelV4StreamPart {
	return { type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "look", input: "{}" };
}

function finish(
	reason: "stop" | "tool-calls",
	inputTokens: number,
	outputTokens: number,
): LanguageModelV4StreamPart {
	return {
		type: "finish",
		finishReason: { unified: reason, raw: reason },
		usage: {
			inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
		},
	};
}

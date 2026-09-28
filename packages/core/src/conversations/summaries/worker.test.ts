import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { ModelRequestFailed, type TurnModel } from "../turns/model.ts";
import { type PreparedSummary, SummarySkipped, type SummaryStore } from "./store.ts";
import type { SummaryRequest } from "./summary.workflow.ts";
import { summarise } from "./worker.ts";

/**
 * The stores and models in these cases never query, so the database they run
 * against is one nothing reaches. The real one is the app runtime.
 */
const runWithServices = effectRunner(ManagedRuntime.make(noDatabase));

const request: SummaryRequest = {
	threadId: "0199a3a0-0000-7000-8000-000000000002",
	agentId: "0199a3a0-0000-7000-8000-000000000003",
	sourceMessageId: "0199a3a0-0000-7000-8000-000000000004",
};

const prepared: PreparedSummary = {
	request,
	turnId: "0199a3a0-0000-7000-8000-000000000005",
	threadId: request.threadId,
	workspaceId: "0199a3a0-0000-7000-8000-000000000006",
	sourceMessageId: request.sourceMessageId,
	threadTitle: "Prepare release notes",
	model: "claude-sonnet-4-20250514",
	transcript: [
		{ author: "Sam", kind: "person", content: "Prepare release notes" },
		{ author: "Release Agent", kind: "agent", content: "The notes are ready." },
	],
};

describe("summarise", () => {
	it("records a timeout rather than a shutdown and aborts without retrying", async () => {
		vi.useFakeTimers();
		const store = summaryStore();
		let signal: AbortSignal | undefined;
		const stream = vi.fn<TurnModel["stream"]>((input) => {
			signal = input.signal;
			return Effect.never;
		});
		try {
			const execution = runWithServices(summarise(request, { store, model: { stream } }));
			await vi.advanceTimersByTimeAsync(120_000);
			await execution;
			expect(signal?.aborted).toBe(true);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(store.fail).toHaveBeenCalledWith(prepared, "The model did not answer in time.");
			expect(store.complete).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists the first generated title and summary", async () => {
		const store = summaryStore();
		const model: TurnModel = {
			stream: () =>
				Effect.sync(() => ({
					text: chunks('{"title":"Prepare release notes",', '"summary":"Notes are ready."}'),
					accounting: Effect.succeed({
						usage: { modelCalls: 1, inputTokens: 20, outputTokens: 4, totalTokens: 24 },
						reportedCost: 0.002,
					}),
				})),
		};

		await runWithServices(summarise(request, { store, model }));

		expect(store.complete).toHaveBeenCalledWith(
			prepared,
			{ title: "Prepare release notes", content: "Notes are ready." },
			{
				usage: { modelCalls: 1, inputTokens: 20, outputTokens: 4, totalTokens: 24 },
				reportedCost: 0.002,
			},
		);
		expect(store.fail).not.toHaveBeenCalled();
	});

	it("asks again when the first summary is not the shape it asked for", async () => {
		const store = summaryStore();
		const stream = vi.fn(() =>
			Effect.sync(() => ({
				text: chunks("Notes are ready."),
				accounting: Effect.succeed({ usage: {} }),
			})),
		);

		await runWithServices(summarise(request, { store, model: { stream } }));

		// Three asks, then the thread is left without a summary rather than the
		// job being burned on one bad answer.
		expect(stream).toHaveBeenCalledTimes(3);
		expect(store.complete).not.toHaveBeenCalled();
		expect(store.fail).toHaveBeenCalledWith(prepared, "The model's answer could not be used.");
	});

	it("takes the answer as soon as one of the asks comes back usable", async () => {
		const store = summaryStore();
		const stream = vi
			.fn(() =>
				Effect.sync(() => ({
					text: chunks('{"title":"Release","summary":"Notes are ready."}'),
					accounting: Effect.succeed({ usage: {} }),
				})),
			)
			.mockImplementationOnce(() =>
				Effect.sync(() => ({
					text: chunks("Here you go: Notes are ready."),
					accounting: Effect.succeed({ usage: {} }),
				})),
			);

		await runWithServices(summarise(request, { store, model: { stream } }));

		expect(stream).toHaveBeenCalledTimes(2);
		expect(store.fail).not.toHaveBeenCalled();
		expect(store.complete).toHaveBeenCalledWith(
			prepared,
			{ title: "Release", content: "Notes are ready." },
			expect.anything(),
		);
	});

	it("reads a first summary the model wrapped in a markdown fence", async () => {
		const store = summaryStore();
		const fenced = ["```json", '{"title":"Release","summary":"Notes are ready."}', "```"].join(
			"\n",
		);

		await runWithServices(
			summarise(request, {
				store,
				model: {
					stream: () =>
						Effect.sync(() => ({
							text: chunks(fenced),
							accounting: Effect.succeed({ usage: {} }),
						})),
				},
			}),
		);

		expect(store.fail).not.toHaveBeenCalled();
		expect(store.complete).toHaveBeenCalledWith(
			prepared,
			{ title: "Release", content: "Notes are ready." },
			expect.anything(),
		);
	});

	it("does not re-ask a provider that is down, and records the failure", async () => {
		const store = summaryStore();
		const stream = vi.fn(() =>
			Effect.fail(
				new ModelRequestFailed({ message: "provider unavailable", reason: "unavailable" }),
			),
		);

		await runWithServices(summarise(request, { store, model: { stream } }));

		// Asking again would cost the same and fail the same way. The thread's
		// next turn asks for a summary again.
		expect(stream).toHaveBeenCalledTimes(1);
		expect(store.fail).toHaveBeenCalledWith(prepared, "The model provider could not answer.");
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("does nothing when the summary is no longer needed", async () => {
		const store = summaryStore();
		vi.mocked(store.prepare).mockReturnValueOnce(
			Effect.fail(
				new SummarySkipped({ reason: "The thread is already summarised to this message" }),
			),
		);

		await runWithServices(summarise(request, { store, model: unusedModel() }));

		expect(store.complete).not.toHaveBeenCalled();
		expect(store.fail).not.toHaveBeenCalled();
	});

	it("leaves a transient failure to the engine, which retries the activity", async () => {
		const store = summaryStore();
		vi.mocked(store.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await expect(
			runWithServices(summarise(request, { store, model: unusedModel() })),
		).rejects.toThrow("database unavailable");
	});
});

function summaryStore(): SummaryStore {
	return {
		prepare: vi.fn(() => Effect.succeed(prepared)),
		complete: vi.fn(() => Effect.void),
		fail: vi.fn(() => Effect.void),
	};
}

function unusedModel(): TurnModel {
	return {
		stream: () =>
			Effect.fail(new ModelRequestFailed({ message: "unused model", reason: "unavailable" })),
	};
}

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) {
		yield value;
	}
}

import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner, type RunEffect } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { ModelRequestFailed, type TurnModel } from "../turns/model.ts";
import type { ClaimedSummary, PreparedSummary, SummaryStore } from "./store.ts";
import { runClaimedSummary, type SummaryWorkerOptions, summaryWorkerLayer } from "./worker.ts";

/**
 * The stores and models in these cases never query, so the database they run
 * against is one nothing reaches. The real one is the app runtime.
 */
const runWithServices: RunEffect = effectRunner(ManagedRuntime.make(noDatabase));

const claimed: ClaimedSummary = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	threadId: "0199a3a0-0000-7000-8000-000000000002",
	payload: {
		agentId: "0199a3a0-0000-7000-8000-000000000003",
		sourceMessageId: "0199a3a0-0000-7000-8000-000000000004",
	},
	dedupeKey: "thread-summary:0199a3a0-0000-7000-8000-000000000002",
	attempts: 1,
};

const prepared: PreparedSummary = {
	job: claimed,
	turnId: "0199a3a0-0000-7000-8000-000000000005",
	threadId: claimed.threadId,
	workspaceId: "0199a3a0-0000-7000-8000-000000000006",
	sourceMessageId: claimed.payload.sourceMessageId,
	threadTitle: "Prepare release notes",
	model: "claude-sonnet-4-20250514",
	transcript: [
		{ author: "Sam", kind: "person", content: "Prepare release notes" },
		{ author: "Release Agent", kind: "agent", content: "The notes are ready." },
	],
};

describe("runClaimedSummary", () => {
	it("records a timeout rather than a shutdown and aborts without retrying", async () => {
		vi.useFakeTimers();
		const store = summaryStore();
		let signal: AbortSignal | undefined;
		const stream = vi.fn<TurnModel["stream"]>((input) => {
			signal = input.signal;
			return Effect.never;
		});
		try {
			const execution = runWithServices(runClaimedSummary(claimed, { store, model: { stream } }));
			await vi.advanceTimersByTimeAsync(120_000);
			await execution;
			expect(signal?.aborted).toBe(true);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(store.fail).toHaveBeenCalledWith(prepared, "Thread summary timed out");
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

		await runWithServices(runClaimedSummary(claimed, { store, model }));

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

		await runWithServices(runClaimedSummary(claimed, { store, model: { stream } }));

		// Three asks, then the thread is left without a summary rather than the
		// job being burned on one bad answer.
		expect(stream).toHaveBeenCalledTimes(3);
		expect(store.complete).not.toHaveBeenCalled();
		expect(store.fail).toHaveBeenCalledWith(prepared, "Thread summary model returned invalid JSON");
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

		await runWithServices(runClaimedSummary(claimed, { store, model: { stream } }));

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
			runClaimedSummary(claimed, {
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

	it("does not re-ask a provider that is down, and leaves that to the job", async () => {
		const store = summaryStore();
		const stream = vi.fn(() =>
			Effect.fail(new ModelRequestFailed({ message: "provider unavailable" })),
		);

		await runWithServices(runClaimedSummary(claimed, { store, model: { stream } }));

		// Asking again would cost the same and fail the same way. The job's own
		// retry, with its backoff, is what handles a provider coming back.
		expect(stream).toHaveBeenCalledTimes(1);
		expect(store.fail).toHaveBeenCalledWith(prepared, "provider unavailable");
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("releases a claim when summary preparation fails transiently", async () => {
		const store = summaryStore();
		vi.mocked(store.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await runWithServices(
			runClaimedSummary(claimed, {
				store,
				model: unusedModel(),
			}),
		);

		expect(store.releaseFailedClaim).toHaveBeenCalledWith(claimed, "database unavailable");
		expect(store.discard).not.toHaveBeenCalled();
	});
});

/**
 * Running the layer starts the worker; disposing the runtime interrupts it,
 * which is the whole of what shutting one down means now.
 */
function running(store: SummaryStore, options: Omit<SummaryWorkerOptions, "store">) {
	return ManagedRuntime.make(
		summaryWorkerLayer({ store, ...options }).pipe(Layer.provide(noDatabase)),
	);
}

describe("the summary worker", () => {
	it("aborts a blocked stream and finishes its outcome write before disposal", async () => {
		const store = summaryStore();
		vi.mocked(store.claimNext).mockReturnValueOnce(Effect.succeed(claimed));
		const reading = Promise.withResolvers<void>();
		const writing = Promise.withResolvers<void>();
		const finishWrite = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		vi.mocked(store.fail).mockImplementation(() =>
			Effect.promise(async () => {
				writing.resolve();
				await finishWrite.promise;
			}),
		);
		const worker = running(store, {
			model: {
				stream: (input) => {
					signal = input.signal;
					return Effect.succeed({
						text: (async function* () {
							yield "partial";
							reading.resolve();
							await new Promise<void>((resolve) => {
								input.signal.addEventListener("abort", () => resolve(), { once: true });
							});
						})(),
						accounting: Effect.succeed({ usage: {} }),
					});
				},
			},
		});
		let disposed = false;
		try {
			await worker.runPromise(Effect.void);
			await reading.promise;
			const disposal = worker.dispose().then(() => {
				disposed = true;
			});
			await writing.promise;
			expect(signal?.aborted).toBe(true);
			expect(store.fail).toHaveBeenCalledWith(prepared, "Worker stopped");
			expect(disposed).toBe(false);
			finishWrite.resolve();
			await disposal;
			expect(store.complete).not.toHaveBeenCalled();
		} finally {
			finishWrite.resolve();
			await worker.dispose();
		}
	});

	it("retries interrupted-job recovery before claiming work", async () => {
		vi.useFakeTimers();
		const store = summaryStore();
		vi.mocked(store.requeueInterrupted)
			.mockReturnValueOnce(Effect.die(new Error("database unavailable")))
			.mockReturnValueOnce(Effect.void);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = running(store, { model: unusedModel(), pollIntervalMs: 10 });
		try {
			await worker.runPromise(Effect.void);
			await vi.advanceTimersByTimeAsync(50);
			expect(store.requeueInterrupted).toHaveBeenCalledTimes(2);
			expect(store.claimNext).toHaveBeenCalled();
		} finally {
			await worker.dispose();
			error.mockRestore();
			vi.useRealTimers();
		}
	});

	it("stops while recovery is waiting to retry", async () => {
		vi.useFakeTimers();
		const store = summaryStore();
		vi.mocked(store.requeueInterrupted).mockReturnValue(
			Effect.die(new Error("database unavailable")),
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = running(store, { model: unusedModel(), pollIntervalMs: 10_000 });
		try {
			await worker.runPromise(Effect.void);
			await vi.advanceTimersByTimeAsync(0);
			await worker.dispose();
			expect(store.claimNext).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			vi.useRealTimers();
		}
	});
});

function summaryStore(): SummaryStore {
	return {
		requeueInterrupted: vi.fn(() => Effect.void),
		claimNext: vi.fn(() => Effect.undefined),
		releaseFailedClaim: vi.fn(() => Effect.void),
		prepare: vi.fn(() => Effect.succeed(prepared)),
		complete: vi.fn(() => Effect.void),
		fail: vi.fn(() => Effect.void),
		discard: vi.fn(() => Effect.void),
	};
}

function unusedModel(): TurnModel {
	return {
		stream: () => Effect.fail(new ModelRequestFailed({ message: "unused model" })),
	};
}

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) {
		yield value;
	}
}

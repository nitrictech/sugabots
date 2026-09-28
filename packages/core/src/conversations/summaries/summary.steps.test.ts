import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { ModelRequestFailed, type TurnModel } from "../turns/model.ts";
import type { PreparedSummary } from "./summaries.ts";
import type { SummaryExecution } from "./summary.steps.ts";
import { summarise } from "./summary.steps.ts";
import type { SummaryRequest } from "./summary.workflow.ts";

/**
 * The services and models in these cases never query, so the database they run
 * against is one nothing reaches. The real one is the app runtime.
 */
const runWithServices = effectRunner(ManagedRuntime.make(noDatabase));

const request: SummaryRequest = {
	threadId: "0199a3a0-0000-7000-8000-000000000002",
	agentId: "0199a3a0-0000-7000-8000-000000000003",
	sourceMessageId: "0199a3a0-0000-7000-8000-000000000004",
};

const prepared: PreparedSummary = {
	_tag: "Prepared",
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
		const { summaries, turns } = fakes();
		let signal: AbortSignal | undefined;
		const stream = vi.fn<TurnModel["stream"]>((input) => {
			signal = input.signal;
			return Effect.never;
		});
		try {
			const execution = runWithServices(
				summarise(request, { summaries, turns, model: { stream } }),
			);
			await vi.advanceTimersByTimeAsync(120_000);
			await execution;
			expect(signal?.aborted).toBe(true);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(turns.failScribeTurn).toHaveBeenCalledWith(
				prepared.turnId,
				"The model did not answer in time.",
			);
			expect(summaries.complete).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists the first generated title and summary", async () => {
		const { summaries, turns } = fakes();
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

		await runWithServices(summarise(request, { summaries, turns, model }));

		expect(summaries.complete).toHaveBeenCalledWith(
			prepared,
			{ title: "Prepare release notes", content: "Notes are ready." },
			{
				usage: { modelCalls: 1, inputTokens: 20, outputTokens: 4, totalTokens: 24 },
				reportedCost: 0.002,
			},
		);
		expect(turns.failScribeTurn).not.toHaveBeenCalled();
	});

	it("asks again when the first summary is not the shape it asked for", async () => {
		const { summaries, turns } = fakes();
		const stream = vi.fn(() =>
			Effect.sync(() => ({
				text: chunks("Notes are ready."),
				accounting: Effect.succeed({ usage: {} }),
			})),
		);

		await runWithServices(summarise(request, { summaries, turns, model: { stream } }));

		// Three asks, then the thread is left without a summary rather than the
		// job being burned on one bad answer.
		expect(stream).toHaveBeenCalledTimes(3);
		expect(summaries.complete).not.toHaveBeenCalled();
		expect(turns.failScribeTurn).toHaveBeenCalledWith(
			prepared.turnId,
			"The model's answer could not be used.",
		);
	});

	it("takes the answer as soon as one of the asks comes back usable", async () => {
		const { summaries, turns } = fakes();
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

		await runWithServices(summarise(request, { summaries, turns, model: { stream } }));

		expect(stream).toHaveBeenCalledTimes(2);
		expect(turns.failScribeTurn).not.toHaveBeenCalled();
		expect(summaries.complete).toHaveBeenCalledWith(
			prepared,
			{ title: "Release", content: "Notes are ready." },
			expect.anything(),
		);
	});

	it("reads a first summary the model wrapped in a markdown fence", async () => {
		const { summaries, turns } = fakes();
		const fenced = ["```json", '{"title":"Release","summary":"Notes are ready."}', "```"].join(
			"\n",
		);

		await runWithServices(
			summarise(request, {
				summaries,
				turns,
				model: {
					stream: () =>
						Effect.sync(() => ({
							text: chunks(fenced),
							accounting: Effect.succeed({ usage: {} }),
						})),
				},
			}),
		);

		expect(turns.failScribeTurn).not.toHaveBeenCalled();
		expect(summaries.complete).toHaveBeenCalledWith(
			prepared,
			{ title: "Release", content: "Notes are ready." },
			expect.anything(),
		);
	});

	it("does not re-ask a provider that is down, and records the failure", async () => {
		const { summaries, turns } = fakes();
		const stream = vi.fn(() =>
			Effect.fail(
				new ModelRequestFailed({ message: "provider unavailable", reason: "unavailable" }),
			),
		);

		await runWithServices(summarise(request, { summaries, turns, model: { stream } }));

		// Asking again would cost the same and fail the same way. The thread's
		// next turn asks for a summary again.
		expect(stream).toHaveBeenCalledTimes(1);
		expect(turns.failScribeTurn).toHaveBeenCalledWith(
			prepared.turnId,
			"The model provider could not answer.",
		);
		expect(summaries.complete).not.toHaveBeenCalled();
	});

	it("does nothing when the summary is no longer needed", async () => {
		const { summaries, turns } = fakes();
		vi.mocked(summaries.prepare).mockReturnValueOnce(
			Effect.succeed({
				_tag: "Skipped",
				reason: "The thread is already summarised to this message",
			}),
		);

		await runWithServices(summarise(request, { summaries, turns, model: unusedModel() }));

		expect(summaries.complete).not.toHaveBeenCalled();
		expect(turns.failScribeTurn).not.toHaveBeenCalled();
	});

	it("leaves a transient failure to the engine, which retries the activity", async () => {
		const { summaries, turns } = fakes();
		vi.mocked(summaries.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await expect(
			runWithServices(summarise(request, { summaries, turns, model: unusedModel() })),
		).rejects.toThrow("database unavailable");
	});
});

/** Prepares `prepared` and records nothing; the cases check what was asked to be recorded. */
function fakes(): Pick<SummaryExecution, "summaries" | "turns"> {
	return {
		summaries: {
			prepare: vi.fn(() => Effect.succeed(prepared)),
			complete: vi.fn(() => Effect.void),
		},
		turns: { failScribeTurn: vi.fn(() => Effect.void) },
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

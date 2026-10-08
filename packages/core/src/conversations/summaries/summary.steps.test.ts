import { DisplayName } from "@sugabots/errors";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../database/database.ts";
import { noDatabase } from "../../database/testing.ts";
import { Models } from "../../providers/models/models.ts";
import { chunks, scriptedModel, streamed, unusedModel } from "../../providers/models/testing.ts";
import { unimplemented } from "../../testing.ts";
import { Turns } from "../turns/turns.ts";
import { type PreparedSummary, Summaries } from "./summaries.ts";
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
	scribe: {
		threadId: "0199a3a0-0000-7000-8000-000000000005",
		agentId: "0199a3a0-0000-7000-8000-000000000008",
	},
	threadId: request.threadId,
	workspaceId: "0199a3a0-0000-7000-8000-000000000006",
	podId: "0199a3a0-0000-7000-8000-000000000007",
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
		const { summaries, turns, ended } = fakes();
		let signal: AbortSignal | undefined;
		const stream = vi.fn<Models.Interface["stream"]>(() =>
			Effect.gen(function* () {
				signal = yield* Effect.abortSignal;
				return yield* Effect.never;
			}),
		);
		try {
			const execution = runWithServices(
				summarise(request, Models.fromStream(stream)).pipe(
					Effect.provide(services(summaries, turns)),
				),
			);
			await vi.advanceTimersByTimeAsync(120_000);
			await execution;
			expect(signal?.aborted).toBe(true);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(ended).toEqual([{ failed: "The model didn't answer in time. Try again." }]);
			expect(summaries.complete).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists the first generated title and summary", async () => {
		const { summaries, turns, recorded, ended } = fakes();
		const model = Models.fromStream(() =>
			Effect.sync(() =>
				streamed(chunks('{"title":"Prepare release notes",', '"summary":"Notes are ready."}'), {
					contextTokens: 20,
				}),
			),
		);

		await runWithServices(
			summarise(request, model).pipe(Effect.provide(services(summaries, turns))),
		);

		expect(recorded).toEqual([
			{
				...prepared.scribe,
				triggerMessageId: request.sourceMessageId,
				model: prepared.model,
				name: "summary",
			},
		]);
		expect(summaries.complete).toHaveBeenCalledWith(prepared, {
			title: "Prepare release notes",
			content: "Notes are ready.",
		});
		expect(ended).toEqual([{ completed: 20 }]);
	});

	it("asks again when the first summary is not the shape it asked for", async () => {
		const { summaries, turns, ended } = fakes();
		const stream = vi.fn(() => Effect.sync(() => streamed(chunks("Notes are ready."))));

		await runWithServices(
			summarise(request, Models.fromStream(stream)).pipe(
				Effect.provide(services(summaries, turns)),
			),
		);

		// Three asks, then the thread is left without a summary rather than the
		// whole summary being retried over one bad answer.
		expect(stream).toHaveBeenCalledTimes(3);
		expect(summaries.complete).not.toHaveBeenCalled();
		expect(ended).toEqual([{ failed: "The model answered in a form we couldn't use. Try again." }]);
	});

	it("takes the answer as soon as one of the asks comes back usable", async () => {
		const { summaries, turns, ended } = fakes();
		const stream = vi
			.fn(() =>
				Effect.sync(() => streamed(chunks('{"title":"Release","summary":"Notes are ready."}'))),
			)
			.mockImplementationOnce(() =>
				Effect.sync(() => streamed(chunks("Here you go: Notes are ready."))),
			);

		await runWithServices(
			summarise(request, Models.fromStream(stream)).pipe(
				Effect.provide(services(summaries, turns)),
			),
		);

		expect(stream).toHaveBeenCalledTimes(2);
		expect(ended).toEqual([{ completed: undefined }]);
		expect(summaries.complete).toHaveBeenCalledWith(prepared, {
			title: "Release",
			content: "Notes are ready.",
		});
	});

	it("reads a first summary the model wrapped in a markdown fence", async () => {
		const { summaries, turns, ended } = fakes();
		const fenced = ["```json", '{"title":"Release","summary":"Notes are ready."}', "```"].join(
			"\n",
		);

		await runWithServices(
			summarise(request, scriptedModel(fenced)).pipe(Effect.provide(services(summaries, turns))),
		);

		expect(ended).toEqual([{ completed: undefined }]);
		expect(summaries.complete).toHaveBeenCalledWith(prepared, {
			title: "Release",
			content: "Notes are ready.",
		});
	});

	it("does not re-ask a provider that is down, and records the failure", async () => {
		const { summaries, turns, ended } = fakes();
		const unreachable = new Models.ProviderUnreachable({
			provider: DisplayName.fromRecord("Test provider"),
			model: DisplayName.fromRecord("test-model"),
			cause: new Error("ECONNREFUSED"),
		});
		const stream = vi.fn(() => Effect.fail(unreachable));

		await runWithServices(
			summarise(request, Models.fromStream(stream)).pipe(
				Effect.provide(services(summaries, turns)),
			),
		);

		// Asking again would cost the same and fail the same way. The thread's
		// next turn asks for a summary again.
		expect(stream).toHaveBeenCalledTimes(1);
		expect(ended).toEqual([{ failed: unreachable.userMessage }]);
		expect(summaries.complete).not.toHaveBeenCalled();
	});

	it("does nothing when the summary is no longer needed", async () => {
		const { summaries, turns, recorded } = fakes();
		vi.mocked(summaries.prepare).mockReturnValueOnce(
			Effect.succeed({
				_tag: "Skipped",
				reason: "The thread is already summarised to this message",
			}),
		);

		await runWithServices(
			summarise(request, unusedModel()).pipe(Effect.provide(services(summaries, turns))),
		);

		expect(summaries.complete).not.toHaveBeenCalled();
		expect(recorded).toEqual([]);
	});

	it("leaves a transient failure to the engine, which retries the activity", async () => {
		const { summaries, turns } = fakes();
		vi.mocked(summaries.prepare).mockReturnValueOnce(Effect.die(new Error("database unavailable")));

		await expect(
			runWithServices(
				summarise(request, unusedModel()).pipe(Effect.provide(services(summaries, turns))),
			),
		).rejects.toThrow("database unavailable");
	});
});

/**
 * Prepares `prepared` and records nothing. The Scribe's turn is recorded as
 * how its work ended, as `Turns.recordSystemTurn` would write it: completed
 * with the prompt size measured, or failed with what people are told.
 */
function fakes() {
	const recorded: Turns.SystemTurn[] = [];
	const ended: Array<{ completed: number | undefined } | { failed: string }> = [];
	const recordSystemTurn: Turns.Interface["recordSystemTurn"] = (systemTurn, work) =>
		Effect.suspend(() => {
			recorded.push(systemTurn);
			return work("0199a3a0-0000-7000-8000-000000000009").pipe(
				Effect.map(({ value, contextTokens }) => {
					ended.push({ completed: contextTokens });
					return { _tag: "Completed", value } as const;
				}),
				Effect.catch((failure) =>
					Effect.sync(() => {
						ended.push({ failed: failure.userMessage });
						return { _tag: "Failed" } as const;
					}),
				),
			);
		});
	return {
		summaries: {
			prepare: vi.fn<Summaries.Interface["prepare"]>(() => Effect.succeed(prepared)),
			complete: vi.fn<Summaries.Interface["complete"]>(() => Effect.void),
		},
		turns: { recordSystemTurn },
		recorded,
		ended,
	};
}

/** The services a summary runs on, doing only what `summaries` and `turns` do. */
function services(summaries: Partial<Summaries.Interface>, turns: Partial<Turns.Interface>) {
	return Layer.mergeAll(
		unimplemented(Summaries.Service, summaries),
		unimplemented(Turns.Service, turns),
	);
}

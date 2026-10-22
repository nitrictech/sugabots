import { DisplayName } from "@sugabots/errors";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { noDatabase } from "../../database/testing.ts";
import { Models } from "../../providers/models/models.ts";
import { chunks, streamed } from "../../providers/models/testing.ts";
import { CASES, type TrialSystemAgent } from "./cases.ts";
import { ACCURACY_NEEDED, BUDGET_MS, explain, rateAccuracy, rateSpeed, runTrial } from "./trial.ts";

/** A model that answers whatever it is told to, so the grading is what is under test. */
function scripted(
	answer: (input: Models.StreamRequest) => string | Models.RequestFailure,
): Models.Interface {
	return Models.fromStream((input) => {
		const next = answer(input);
		return typeof next !== "string" ? Effect.fail(next) : Effect.succeed(streamed(chunks(next)));
	});
}

const trial = (model: Models.Interface, systemAgentKey: TrialSystemAgent, attempts = 1) =>
	Effect.runPromise(
		Effect.provide(
			runTrial({ systemAgentKey, model: "under-trial", workspaceId: "w1", attempts }, model),
			noDatabase,
		),
	);

describe("rating a model", () => {
	it("treats nine in ten as the floor, not a good score", () => {
		expect(rateAccuracy(20, 20)).toBe("excellent");
		expect(rateAccuracy(18, 20)).toBe("good");
		// One in four wrong is not "good" for something that runs unattended.
		expect(rateAccuracy(16, 20)).toBe("poor");
		expect(rateAccuracy(9, 20)).toBe("terrible");
	});

	it("calls a model that answers nothing terrible rather than dividing by zero", () => {
		expect(rateAccuracy(0, 0)).toBe("terrible");
	});

	it("judges speed against what the system agent can afford to wait", () => {
		expect(rateSpeed(15_000, BUDGET_MS.summarise)).toBe("excellent");
		expect(rateSpeed(25_000, BUDGET_MS.summarise)).toBe("good");
		expect(rateSpeed(45_000, BUDGET_MS.summarise)).toBe("poor");
		expect(rateSpeed(90_000, BUDGET_MS.summarise)).toBe("terrible");
		// Nobody reads a compaction, so it can take longer still.
		expect(rateSpeed(45_000, BUDGET_MS.compact)).toBe("excellent");
	});
});

describe("running a trial", () => {
	it("rates a model that answers every case correctly as excellent", async () => {
		// The right answer differs per case, so the script reads the prompt.
		const report = await trial(scripted(summaryAnswer), "summarise");

		expect(report.rating).toBe("excellent");
		expect(report.accuracy.passed).toBe(report.accuracy.attempts);
	});

	it("counts a model that cannot answer at all as a failure, not an error", async () => {
		const report = await trial(
			scripted(() => new Models.ModelNotOffered({ model: DisplayName.fromRecord("test-model") })),
			"summarise",
		);

		expect(report.rating).toBe("terrible");
		expect(report.cases.every((one) => one.example === "(no answer)")).toBe(true);
	});

	it("counts a model defect as a failed answer", async () => {
		const report = await trial(
			Models.fromStream(() => Effect.die(new Error("model defect"))),
			"summarise",
		);

		expect(report.accuracy.passed).toBe(0);
		expect(report.cases.every((one) => one.example === "(no answer)")).toBe(true);
	});

	it("aborts stalled streams on timeout and continues the trial", async () => {
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			const reportPromise = trial(
				Models.fromStream(() =>
					Effect.gen(function* () {
						const signal = yield* Effect.abortSignal;
						signals.push(signal);
						return streamed(
							(async function* () {
								await new Promise<void>((resolve) => {
									signal.addEventListener("abort", () => resolve(), { once: true });
								});
								yield "too late";
							})(),
						);
					}),
				),
				"summarise",
			);
			await vi.advanceTimersByTimeAsync(0);
			for (let index = 0; index < CASES.summarise.length; index += 1) {
				expect(signals[index]?.aborted).toBe(false);
				await vi.advanceTimersByTimeAsync(45_000);
				expect(signals[index]?.aborted).toBe(true);
			}
			const report = await reportPromise;
			expect(signals).toHaveLength(CASES.summarise.length);
			expect(report.accuracy.passed).toBe(0);
			expect(report.cases.every((one) => one.example === "(no answer)")).toBe(true);
			expect(report.speed.typicalMs).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("trying a model on the summariser", () => {
	it("accepts only what summarising would accept", async () => {
		const report = await trial(scripted(summaryAnswer), "summarise");

		expect(report.rating).toBe("excellent");
	});

	it("fails a model that answers prose where strict JSON was asked for", async () => {
		const report = await trial(
			scripted(() => "Here is your summary: two are on hold."),
			"summarise",
		);

		const first = report.cases.find((one) => one.name.includes("strict JSON"));
		expect(first?.passed).toBe(0);
		expect(first?.example).toContain("Here is your summary");
	});
});

describe("what the report tells the person choosing", () => {
	it("rates an accurate but slow summariser badly, and says it has to be faster", () => {
		// The point of measuring speed at all: being right is not enough when
		// the answer comes after anyone wanted it.
		const accuracy = {
			passed: 15,
			attempts: 15,
			share: 1,
			needed: ACCURACY_NEEDED,
			rating: rateAccuracy(15, 15),
		};
		const speed = {
			typicalMs: 90_000,
			slowestMs: 110_000,
			budgetMs: BUDGET_MS.summarise,
			rating: rateSpeed(90_000, BUDGET_MS.summarise),
		};

		expect(speed.rating).toBe("terrible");
		const said = explain("summarise", accuracy, speed, []).join(" ");
		expect(said).toContain("Too slow");
		expect(said).toContain("about 90.0s");
		expect(said).toContain("under 20.0s");
		expect(said).toContain("a summary nobody waits for");
	});

	it("says how often it was right and how often it needs to be", async () => {
		const report = await trial(
			scripted(() => "Here is your summary: two are on hold."),
			"summarise",
		);

		expect(report.verdict.join(" ")).toContain("Too often wrong");
		expect(report.verdict.join(" ")).toContain("at least 90%");
		// And which case, with what it actually answered, so the next choice is
		// informed rather than another guess.
		expect(report.verdict.join(" ")).toContain("Returns a title and summary as strict JSON");
	});

	it("says plainly when a model is good enough to rely on", async () => {
		const report = await trial(scripted(summaryAnswer), "summarise");

		expect(report.rating).toBe("excellent");
		expect(report.verdict.join(" ")).toContain("Good enough to rely on");
	});
});

/** What a summariser that does its job answers, whichever case this prompt is. */
function summaryAnswer(input: Models.StreamRequest): string {
	return input.system.includes("strict JSON")
		? '{"title":"September invoices","summary":"Two are on hold."}'
		: "Two invoices are on hold until their purchase orders reopen.";
}

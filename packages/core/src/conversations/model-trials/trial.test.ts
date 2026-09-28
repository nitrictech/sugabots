import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { noDatabase } from "../../database/testing.ts";
import { Models } from "../../providers/models/models.ts";
import { CASES } from "./cases.ts";
import { ACCURACY_NEEDED, BUDGET_MS, explain, rateAccuracy, rateSpeed, runTrial } from "./trial.ts";

/** A model that answers whatever it is told to, so the grading is what is under test. */
function scripted(
	answer: (input: Models.Input) => string | Models.ModelRequestFailed,
): Models.Interface {
	return {
		stream: (input) => {
			const next = answer(input);
			return next instanceof Models.ModelRequestFailed
				? Effect.fail(next)
				: Effect.succeed({
						text: (async function* () {
							yield next;
						})(),
						accounting: Effect.succeed({ modelCalls: 1 }),
					});
		},
	};
}

const trial = (model: Models.Interface, systemAgentKey: "facilitate" | "summarise", attempts = 1) =>
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
		expect(rateSpeed(1_500, BUDGET_MS.facilitate)).toBe("excellent");
		expect(rateSpeed(2_500, BUDGET_MS.facilitate)).toBe("good");
		expect(rateSpeed(4_500, BUDGET_MS.facilitate)).toBe("poor");
		expect(rateSpeed(9_000, BUDGET_MS.facilitate)).toBe("terrible");
		// Summarising happens after the reply, so it can take far longer.
		expect(rateSpeed(9_000, BUDGET_MS.summarise)).toBe("excellent");
	});
});

describe("trying a model on the facilitator", () => {
	it("rates a model that answers every case correctly as excellent", async () => {
		// The right answer differs per case, so the script reads the prompt.
		const report = await trial(scripted(answerFor), "facilitate");

		expect(report.rating).toBe("excellent");
		expect(report.accuracy.passed).toBe(report.accuracy.attempts);
	});

	it("rates a model that always names an agent as terrible, and says which cases failed", async () => {
		// The failure seen in production: the facilitator never answers nobody.
		const report = await trial(
			scripted(() => "@ledger"),
			"facilitate",
		);

		expect(report.rating).toBe("terrible");
		expect(report.cases.filter((one) => one.passed === 0).map((one) => one.name)).toContain(
			"Ends the exchange when an agent is only reflecting on another agent",
		);
	});

	it("counts a model that cannot answer at all as a failure, not an error", async () => {
		const report = await trial(
			scripted(
				() =>
					new Models.ModelRequestFailed({ message: "provider unavailable", reason: "unavailable" }),
			),
			"facilitate",
		);

		expect(report.rating).toBe("terrible");
		expect(report.cases.every((one) => one.example === "(no answer)")).toBe(true);
	});

	it("counts a model defect as a failed answer", async () => {
		const report = await trial(
			{ stream: () => Effect.die(new Error("model defect")) },
			"facilitate",
		);

		expect(report.accuracy.passed).toBe(0);
		expect(report.cases.every((one) => one.example === "(no answer)")).toBe(true);
	});

	it("aborts stalled streams on timeout and continues the trial", async () => {
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			const reportPromise = trial(
				{
					stream: (input) => {
						signals.push(input.signal);
						return Effect.succeed({
							text: (async function* () {
								await new Promise<void>((resolve) => {
									input.signal.addEventListener("abort", () => resolve(), { once: true });
								});
								yield "too late";
							})(),
							accounting: Effect.succeed({ modelCalls: 1 }),
						});
					},
				},
				"facilitate",
			);
			await vi.advanceTimersByTimeAsync(0);
			for (let index = 0; index < CASES.facilitate.length; index += 1) {
				expect(signals[index]?.aborted).toBe(false);
				await vi.advanceTimersByTimeAsync(45_000);
				expect(signals[index]?.aborted).toBe(true);
			}
			const report = await reportPromise;
			expect(signals).toHaveLength(CASES.facilitate.length);
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
		const report = await trial(
			scripted((input) =>
				input.system.includes("strict JSON")
					? '{"title":"September invoices","summary":"Two are on hold."}'
					: "Two invoices are on hold until their purchase orders reopen.",
			),
			"summarise",
		);

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
	it("rates an accurate but slow router badly, and says it has to be fast", () => {
		// The point of measuring speed at all: being right is not enough for a
		// job that runs before anyone can reply.
		const accuracy = {
			passed: 15,
			attempts: 15,
			share: 1,
			needed: ACCURACY_NEEDED,
			rating: rateAccuracy(15, 15),
		};
		const speed = {
			typicalMs: 7_000,
			slowestMs: 9_100,
			budgetMs: BUDGET_MS.facilitate,
			rating: rateSpeed(7_000, BUDGET_MS.facilitate),
		};

		expect(speed.rating).toBe("terrible");
		const said = explain("facilitate", accuracy, speed, []).join(" ");
		expect(said).toContain("Too slow");
		expect(said).toContain("about 7.0s");
		expect(said).toContain("under 2.0s");
		expect(said).toContain("runs before anyone can reply");
	});

	it("says how often it was right and how often it needs to be", async () => {
		const report = await trial(
			scripted(() => "@ledger"),
			"facilitate",
		);

		expect(report.verdict.join(" ")).toContain("Too often wrong");
		expect(report.verdict.join(" ")).toContain("at least 90%");
		// And which case, with what it actually answered, so the next choice is
		// informed rather than another guess.
		expect(report.verdict.join(" ")).toContain("Ends the exchange when an agent is only");
	});

	it("says plainly when a model is good enough to rely on", async () => {
		const report = await trial(scripted(answerFor), "facilitate");

		expect(report.rating).toBe("excellent");
		expect(report.verdict.join(" ")).toContain("Good enough to rely on");
	});
});

/** The answer the facilitator should give for whichever case this prompt is. */
function answerFor(input: Models.Input): string {
	const conversation = input.messages[0]?.content ?? "";
	if (conversation.includes("do you want me to reopen it?")) return "nobody";
	if (conversation.includes("It shows how much the order lifecycle matters")) return "nobody";
	if (conversation.includes("they handle the policy exceptions")) return "nobody";
	if (conversation.includes("anything I should know?")) return "@assistant";
	return "@ledger";
}

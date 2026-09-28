import { Duration, Effect, Ref } from "effect";
import type { Database } from "../../database/database.ts";
import { Models } from "../../providers/models/models.ts";
import { CASES, type TrialCase, type TrialSystemAgent } from "./cases.ts";

/**
 * Trying a model out on a system agent before trusting it with one.
 *
 * A system agent's model is chosen once and then runs unattended, so the first sign
 * that it cannot follow the prompt is a thread that loops or a summary that
 * never appears. This asks it the questions that have gone wrong before, a few
 * times each, and says plainly how often it got them right.
 *
 * Each case is asked more than once on purpose. A model that answers correctly
 * half the time is a worse problem than one that never does, because it looks
 * fine when you try it by hand.
 */

/** How many times each case is asked. */
const ATTEMPTS = 3;

const ANSWER_TIMEOUT = Duration.seconds(45);
/** Long enough for a wordy summary, short enough that a rambling model is a failure. */
const MAX_ANSWER_CHARACTERS = 4_000;

export type TrialRating = "excellent" | "good" | "poor" | "terrible";

/** Worst first, so two judgements can be combined by taking the lower. */
const ORDER: readonly TrialRating[] = ["terrible", "poor", "good", "excellent"];
const worse = (a: TrialRating, b: TrialRating) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

/**
 * How often a system agent has to be right, and how quickly.
 *
 * A system agent runs unattended on every message, so being right nine times in ten
 * is the floor rather than a good score: the tenth is a thread that loops or a
 * summary nobody gets, and no one is watching to catch it.
 *
 * The time budgets differ because the two jobs sit in different places. The
 * router runs *before* anyone can reply, so every millisecond is added to how
 * long a person waits for an answer that has not started yet. Summarising runs
 * after the reply is already on screen, so it only has to finish before someone
 * looks at the panel.
 */
export const ACCURACY_NEEDED = 0.9;

export const BUDGET_MS: Record<TrialSystemAgent, number> = {
	facilitate: 2_000,
	summarise: 20_000,
	compact: 60_000,
};

const WHY_IT_MATTERS: Record<TrialSystemAgent, string> = {
	facilitate: "it runs before anyone can reply, so the wait is added to every message",
	summarise:
		"it runs in the background, but a summary nobody waits for is still a summary nobody reads",
	compact: "it runs in the background, but a long chat keeps growing until it finishes",
};

export interface TrialCaseResult {
	readonly name: string;
	readonly passed: number;
	readonly attempts: number;
	/** One answer that was not accepted, so a person can see what it does wrong. */
	readonly example?: string;
}

export interface TrialAccuracy {
	readonly passed: number;
	readonly attempts: number;
	/** Answers accepted, as a share of every attempt. */
	readonly share: number;
	readonly needed: number;
	readonly rating: TrialRating;
}

export interface TrialSpeed {
	/** The middle of one cold answer per case, so a warm cache cannot flatter it. */
	readonly typicalMs: number;
	readonly slowestMs: number;
	readonly budgetMs: number;
	readonly rating: TrialRating;
}

export interface TrialReport {
	readonly systemAgentKey: TrialSystemAgent;
	readonly model: string;
	/** The worse of the two judgements: a facilitator that is slow is no use, however right. */
	readonly rating: TrialRating;
	readonly accuracy: TrialAccuracy;
	readonly speed: TrialSpeed;
	/** What is wrong and what would be good enough, in sentences. */
	readonly verdict: ReadonlyArray<string>;
	readonly cases: ReadonlyArray<TrialCaseResult>;
}

/**
 * How often it was right.
 *
 * `ACCURACY_NEEDED` is the floor, not a good score, so meeting it exactly is
 * `good` and nothing better.
 */
export function rateAccuracy(passed: number, attempts: number): TrialRating {
	if (attempts === 0) {
		return "terrible";
	}
	const share = passed / attempts;
	if (share >= 0.95) return "excellent";
	if (share >= ACCURACY_NEEDED) return "good";
	if (share >= 0.75) return "poor";
	return "terrible";
}

/** How quickly, against the budget for the job it would be doing. */
export function rateSpeed(typicalMs: number, budgetMs: number): TrialRating {
	if (typicalMs <= budgetMs) return "excellent";
	if (typicalMs <= budgetMs * 1.5) return "good";
	if (typicalMs <= budgetMs * 2.5) return "poor";
	return "terrible";
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * What to tell somebody choosing a model.
 *
 * Each sentence names the shortfall, what would have been good enough, and what
 * this model actually did — so the next choice is informed rather than another
 * guess. Silence about a dimension means it was fine.
 */
export function explain(
	systemAgentKey: TrialSystemAgent,
	accuracy: TrialAccuracy,
	speed: TrialSpeed,
	failing: ReadonlyArray<TrialCaseResult>,
): string[] {
	const said: string[] = [];
	if (accuracy.rating === "excellent" && speed.rating === "excellent") {
		said.push(
			`Right ${percent(accuracy.share)} of the time and answers in about ${seconds(speed.typicalMs)}. Good enough to rely on.`,
		);
	}
	if (accuracy.share < accuracy.needed) {
		said.push(
			`Too often wrong: right ${percent(accuracy.share)} of the time, where a system agent needs at least ${percent(accuracy.needed)}. It runs unattended, so nobody is watching to catch the rest.`,
		);
	} else if (accuracy.rating !== "excellent") {
		said.push(
			`Right ${percent(accuracy.share)} of the time, just past the ${percent(accuracy.needed)} a system agent needs. A more capable model would leave more room.`,
		);
	}
	if (speed.rating !== "excellent") {
		said.push(
			`Too slow: about ${seconds(speed.typicalMs)} to answer, and slowest ${seconds(speed.slowestMs)}, where this needs to be under ${seconds(speed.budgetMs)} because ${WHY_IT_MATTERS[systemAgentKey]}. A smaller or more local model would help.`,
		);
	}
	for (const one of failing) {
		said.push(
			`Failed ${one.attempts - one.passed} of ${one.attempts} — ${one.name}${one.example ? `. It answered: ${JSON.stringify(one.example)}` : ""}`,
		);
	}
	return said;
}

/** The middle value, so one cold start does not stand for the model. */
function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
		: (sorted[middle] ?? 0);
}

interface TrialOptions {
	readonly systemAgentKey: TrialSystemAgent;
	readonly model: string;
	readonly workspaceId: string;
	readonly attempts?: number;
}

/** Runs every case for a system agent and reports how the model did. */
export const runTrial = (
	{ systemAgentKey, model, workspaceId, attempts = ATTEMPTS }: TrialOptions,
	turnModel: Models.Interface,
): Effect.Effect<TrialReport, never, Database> =>
	Effect.gen(function* () {
		const cases = yield* Effect.forEach(
			CASES[systemAgentKey],
			(trialCase) => runCase(trialCase, { model, workspaceId, attempts }, turnModel),
			// One at a time: a local model serving one request at a time would
			// otherwise queue, and the numbers would say more about the queue.
			{ concurrency: 1 },
		);
		const passed = cases.reduce((total, result) => total + result.result.passed, 0);
		const asked = cases.reduce((total, result) => total + result.result.attempts, 0);
		const timings = cases.flatMap((one) => one.timings);
		const budgetMs = BUDGET_MS[systemAgentKey];
		const typicalMs = median(timings);

		const accuracy: TrialAccuracy = {
			passed,
			attempts: asked,
			share: asked === 0 ? 0 : passed / asked,
			needed: ACCURACY_NEEDED,
			rating: rateAccuracy(passed, asked),
		};
		const speed: TrialSpeed = {
			typicalMs,
			slowestMs: timings.length === 0 ? 0 : Math.max(...timings),
			budgetMs,
			// A model that never answered has no time to judge; the accuracy
			// rating already says it is unusable, so speed does not pile on.
			rating: timings.length === 0 ? "excellent" : rateSpeed(typicalMs, budgetMs),
		};
		const results = cases.map((one) => one.result);

		return {
			systemAgentKey,
			model,
			rating: worse(accuracy.rating, speed.rating),
			accuracy,
			speed,
			verdict: explain(
				systemAgentKey,
				accuracy,
				speed,
				results.filter((one) => one.passed < one.attempts),
			),
			cases: results,
		};
	});

const runCase = (
	trialCase: TrialCase,
	{ model, workspaceId, attempts }: { model: string; workspaceId: string; attempts: number },
	turnModel: Models.Interface,
): Effect.Effect<{ result: TrialCaseResult; timings: number[] }, never, Database> =>
	Effect.gen(function* () {
		let passed = 0;
		let example: string | undefined;
		const timings: number[] = [];
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			// Timed around the whole answer, not just opening the stream: what a
			// person waits for is the last token, not the first.
			const [took, answer] = yield* Effect.timed(ask(trialCase, model, workspaceId, turnModel));
			// Only the first attempt at each case is timed, and only when it
			// answered. Providers cache an identical prompt — Ollama returns the
			// second ask in tens of milliseconds — so timing the repeats would
			// report the cache rather than the model. A timeout is not timed
			// either: it would make the typical time the timeout.
			if (answer !== undefined && attempt === 0) {
				timings.push(Duration.toMillis(took));
			}
			// A model that errors or times out has failed the case as surely as
			// one that answers badly; the person choosing it needs to know either
			// way, and a trial must not fail because the subject did.
			if (answer !== undefined && trialCase.accepts(answer)) {
				passed += 1;
			} else if (example === undefined) {
				example = (answer ?? "(no answer)").trim().slice(0, 200);
			}
		}
		return {
			result: {
				name: trialCase.name,
				passed,
				attempts,
				...(example === undefined ? {} : { example }),
			},
			timings,
		};
	});

/** One answer, or `undefined` if the model could not give one. */
const ask = (
	trialCase: TrialCase,
	model: string,
	workspaceId: string,
	turnModel: Models.Interface,
): Effect.Effect<string | undefined, never, Database> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));
			const generated = yield* turnModel.stream({
				...trialCase.prompt(model, workspaceId, stop.signal),
				activity: { purpose: "trial" },
			});
			const collected = yield* Ref.make("");
			yield* Models.forEachDelta(generated.text, stop, (text) =>
				Ref.updateAndGet(collected, (soFar) => soFar + text).pipe(
					Effect.filterOrFail(
						(soFar) => soFar.length <= MAX_ANSWER_CHARACTERS,
						() =>
							new Models.UnusableAnswer({
								reason: "The model kept going well past any usable answer",
							}),
					),
				),
			);
			return yield* Ref.get(collected);
		}),
	).pipe(
		Effect.timeoutOrElse({
			duration: ANSWER_TIMEOUT,
			orElse: () => Effect.undefined,
		}),
		Effect.orElseSucceed(() => undefined),
		Effect.catchDefect(() => Effect.undefined),
	);

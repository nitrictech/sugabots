import { MAX_THREAD_SUMMARY_CHARACTERS, MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { Cause, Duration, Effect, Exit, type Layer, Ref, Schema } from "effect";
import type { Database } from "../../database/database.ts";
import { describeFailure, workerLayer } from "../jobs/worker.ts";
import { retryUnusable, UnusableAnswer } from "../turns/answer.ts";
import { forEachDelta, type ModelAccounting, type TurnModel } from "../turns/model.ts";
import { threadSummaryPrompt } from "./prompt.ts";
import type { ClaimedSummary, PreparedSummary, SummaryStore } from "./store.ts";

const DEFAULT_POLL_INTERVAL_MS = 500;
const SUMMARY_TIMEOUT = Duration.minutes(2);
/** Room for the JSON around a title and a summary; anything longer is the model rambling. */
const MAX_GENERATED_CHARACTERS = MAX_THREAD_SUMMARY_CHARACTERS + MAX_THREAD_TITLE_CHARACTERS + 100;

/** The first summary of a thread also titles it. */
const firstSummarySchema = Schema.Struct({
	title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_THREAD_TITLE_CHARACTERS)),
	summary: Schema.Trim.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_THREAD_SUMMARY_CHARACTERS),
	),
});

export interface SummaryExecution {
	store: SummaryStore;
	model: TurnModel;
}

export interface SummaryWorkerOptions extends SummaryExecution {
	pollIntervalMs?: number;
}

/**
 * Claims summary jobs and runs them one at a time while the runtime lives. One
 * fibre is enough: a summary is cheap and there is at most one queued per thread.
 */
export const summaryWorkerLayer = ({
	store,
	model,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SummaryWorkerOptions): Layer.Layer<never, never, Database> =>
	workerLayer({
		name: "Thread summary worker",
		requeueInterrupted: () => store.requeueInterrupted(),
		claimNext: () => store.claimNext(),
		run: (claimed) => runClaimedSummary(claimed, { store, model }),
		concurrency: 1,
		pollIntervalMs,
	});

/** Runs one claimed summary from preparation to recorded outcome. */
export const runClaimedSummary = (
	claimed: ClaimedSummary,
	execution: SummaryExecution,
): Effect.Effect<void, never, Database> =>
	execution.store.prepare(claimed).pipe(
		Effect.flatMap((prepared) => generateSummary(prepared, execution)),
		Effect.catchTag("JobNotRunnable", (why) => execution.store.discard(claimed, why.reason)),
		Effect.catchDefect((defect) =>
			execution.store.releaseFailedClaim(claimed, describeFailure(defect)),
		),
	);

/**
 * Generates the summary and records how it went. As in the turn worker, only
 * the generation may be interrupted; the outcome is always written.
 */
const generateSummary = (
	prepared: PreparedSummary,
	{ store, model }: SummaryExecution,
): Effect.Effect<void, never, Database> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const generated = yield* Effect.exit(restore(generate(prepared, model)));
			if (Exit.isSuccess(generated)) {
				const [result, accounting] = generated.value;
				return yield* store.complete(prepared, result, accounting);
			}
			const reason = Cause.hasInterruptsOnly(generated.cause)
				? "Worker stopped"
				: describeFailure(Cause.squash(generated.cause));
			yield* store.fail(prepared, reason);
		}),
	);

/** The model's text, parsed into a summary (and a title, the first time), within the time limit. */
const generate = (
	prepared: PreparedSummary,
	model: TurnModel,
): Effect.Effect<
	readonly [{ content: string; title?: string }, ModelAccounting],
	Error,
	Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));

			const generated = yield* model.stream({
				...threadSummaryPrompt(prepared, stop.signal),
				activity: { kind: "thread-summary", threadId: prepared.threadId },
			});
			const collected = yield* Ref.make("");
			yield* forEachDelta(generated.text, stop, (text) =>
				Ref.updateAndGet(collected, (soFar) => soFar + text).pipe(
					Effect.filterOrFail(
						(soFar) => soFar.length <= MAX_GENERATED_CHARACTERS,
						() => new UnusableAnswer({ reason: "Thread summary model returned too much text" }),
					),
					Effect.asVoid,
				),
			);
			const content = yield* Ref.get(collected);
			const result = yield* parseGenerated(content, prepared.previousContent === undefined);
			const accounting = yield* generated.accounting;
			return [result, accounting] as const;
		}),
	).pipe(
		Effect.timeoutOrElse({
			duration: SUMMARY_TIMEOUT,
			orElse: () => Effect.fail(new Error("Thread summary timed out")),
		}),
		// The timeout is inside, so each attempt gets its own two minutes rather
		// than the three of them sharing one.
		retryUnusable,
	);

/**
 * Every way this can go wrong is the model answering in the wrong shape, so
 * every one of them is worth asking again before the summary is given up on.
 *
 * The first summary asks for JSON, which is the shape a model is likeliest to
 * get wrong — a fenced code block, a sentence before the object, a trailing
 * comma. Later summaries are plain text and only length can be wrong.
 */
export function parseGenerated(
	content: string,
	includeTitle: boolean,
): Effect.Effect<{ content: string; title?: string }, UnusableAnswer> {
	const trimmed = content.trim();
	if (!trimmed) {
		return new UnusableAnswer({ reason: "Thread summary model returned no text" });
	}
	if (!includeTitle) {
		return trimmed.length > MAX_THREAD_SUMMARY_CHARACTERS
			? new UnusableAnswer({ reason: "Thread summary model returned too much text" })
			: Effect.succeed({ content: trimmed });
	}
	return Effect.try({
		try: () => JSON.parse(stripFence(trimmed)) as unknown,
		catch: () => new UnusableAnswer({ reason: "Thread summary model returned invalid JSON" }),
	}).pipe(
		Effect.flatMap((parsed) =>
			Schema.decodeUnknownEffect(firstSummarySchema)(parsed).pipe(
				Effect.mapError(
					() =>
						new UnusableAnswer({
							reason: "Thread summary model returned an invalid title or summary",
						}),
				),
				Effect.map((first) => ({ title: first.title, content: first.summary })),
			),
		),
	);
}

/**
 * Models fence JSON in markdown often enough that rejecting it would mean
 * re-asking for something we already have.
 */
function stripFence(text: string): string {
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
	return fenced?.[1]?.trim() ?? text;
}

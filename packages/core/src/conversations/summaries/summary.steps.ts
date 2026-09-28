import { MAX_THREAD_SUMMARY_CHARACTERS, MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { Cause, Data, Duration, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import type { Database } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { AnswerTimedOut, retryUnusable, UnusableAnswer } from "../turns/answer.ts";
import {
	forEachDelta,
	type ModelAccounting,
	type ModelRequestFailed,
	Models,
	type TurnModel,
} from "../turns/model.ts";
import { TurnRepository } from "../turns/repository.ts";
import { threadSummaryPrompt } from "./prompt.ts";
import { type PreparedSummary, Summaries } from "./summaries.ts";
import { type SummaryRequest, SummarySteps } from "./summary.workflow.ts";

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

/** The summary workflow's step, which its activity reaches through `SummarySteps`. */
export const stepsLayer = Layer.effect(
	SummarySteps,
	Effect.gen(function* () {
		const model = yield* Models;
		const services = yield* Effect.context<Summaries.Service | TurnRepository.Service | Database>();
		return SummarySteps.of({
			summarise: (request) => summarise(request, model).pipe(Effect.provideContext(services)),
		});
	}),
);

/**
 * Prepares, generates and records one summary. Nothing to do (the thread is
 * gone, or already summarised this far) is not an error. A failed generation
 * is recorded on the Scribe's turn and not retried: the thread's next turn
 * asks for a summary again.
 */
export const summarise = (
	request: SummaryRequest,
	model: TurnModel,
): Effect.Effect<void, never, Summaries.Service | TurnRepository.Service | Database> =>
	Effect.gen(function* () {
		const summaries = yield* Summaries.Service;
		const preparation = yield* summaries.prepare(request);
		if (preparation._tag === "Prepared") yield* generateSummary(preparation, model);
	});

/**
 * Generates the summary and records how it went. As in a turn's segment, only
 * the generation may be interrupted; the outcome is always written.
 */
const generateSummary = (
	prepared: PreparedSummary,
	model: TurnModel,
): Effect.Effect<void, never, Summaries.Service | TurnRepository.Service | Database> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const summaries = yield* Summaries.Service;
			const turns = yield* TurnRepository.Service;
			const generated = yield* Effect.exit(restore(generate(prepared, model)));
			if (Exit.isSuccess(generated)) {
				const [result, accounting] = generated.value;
				return yield* summaries.complete(prepared, result, accounting);
			}
			const cause = generated.cause;
			const expected = Cause.findErrorOption(cause);
			const failure = Option.isSome(expected)
				? expected.value
				: Cause.hasInterruptsOnly(cause)
					? new SummaryInterrupted()
					: new SummaryStoppedUnexpectedly();
			yield* failure instanceof SummaryStoppedUnexpectedly
				? Effect.logError("A summary died", cause)
				: Effect.logWarning(`A summary failed: ${failure.message}`);
			yield* turns.failSystemAgentTurn(prepared.turnId, failure.userMessage);
		}),
	);

/** The model's text, parsed into a summary (and a title, the first time), within the time limit. */
const generate = (
	prepared: PreparedSummary,
	model: TurnModel,
): Effect.Effect<
	readonly [{ content: string; title?: string }, ModelAccounting],
	SummaryFailure,
	Database
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));

			const generated = yield* model.stream(threadSummaryPrompt(prepared, stop.signal));
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
			orElse: () => Effect.fail(new AnswerTimedOut({ message: "Thread summary timed out" })),
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

/** Why a summary failed. */
type SummaryFailure = ModelRequestFailed | AnswerTimedOut | UnusableAnswer;

/** The process summarising stopped before the summary finished. */
class SummaryInterrupted extends Data.TaggedError("SummaryInterrupted") implements UserFacing {
	override get message() {
		return "Summary interrupted by its process stopping";
	}
	get userMessage() {
		return UserMessage.of`The summary was interrupted.`;
	}
}

/** A defect ended the summary rather than a failure it expects; the defect itself is logged. */
class SummaryStoppedUnexpectedly
	extends Data.TaggedError("SummaryStoppedUnexpectedly")
	implements UserFacing
{
	override get message() {
		return "Summary ended by a defect";
	}
	get userMessage() {
		return UserMessage.of`The summary stopped unexpectedly.`;
	}
}

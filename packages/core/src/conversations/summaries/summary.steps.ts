import { MAX_THREAD_SUMMARY_CHARACTERS, MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { Duration, Effect, Layer, Schema } from "effect";
import type { Database } from "../../database/database.ts";
import { Models } from "../../providers/models/models.ts";
import { Turns } from "../turns/turns.ts";
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
export const summaryStepsLayer = Layer.effect(
	SummarySteps,
	Effect.gen(function* () {
		const model = yield* Models.Service;
		const services = yield* Effect.context<Summaries.Service | Turns.Service | Database>();
		return SummarySteps.of({
			summarise: (request) => summarise(request, model).pipe(Effect.provideContext(services)),
		});
	}),
);

/**
 * Prepares, generates and records one summary, as the Scribe's turn. Nothing
 * to do (the thread is gone, or already summarised this far) is not an
 * error. A failed generation is recorded on the turn and not retried: the
 * thread's next reply asks for a summary again.
 */
export const summarise = (
	request: SummaryRequest,
	model: Models.Interface,
): Effect.Effect<void, never, Summaries.Service | Turns.Service | Database> =>
	Effect.gen(function* () {
		const summaries = yield* Summaries.Service;
		const turns = yield* Turns.Service;
		const prepared = yield* summaries.prepare(request);
		if (prepared._tag === "Skipped") return;
		yield* turns.recordSystemTurn(
			{
				...prepared.scribe,
				triggerMessageId: prepared.sourceMessageId,
				model: prepared.model,
				name: "summary",
			},
			(turnId) =>
				Effect.gen(function* () {
					const [result, contextTokens] = yield* generate(prepared, turnId, model);
					yield* summaries.complete(prepared, result);
					return { value: undefined, contextTokens };
				}),
		);
	});

/** The model's text, parsed into a summary (and a title, the first time), within the time limit. */
const generate = (
	prepared: PreparedSummary,
	turnId: string,
	model: Models.Interface,
): Effect.Effect<
	readonly [{ content: string; title?: string }, contextTokens: number | undefined],
	SummaryFailure,
	Database
> =>
	Effect.gen(function* () {
		const answer = yield* model.answer({
			...threadSummaryPrompt(prepared),
			activity: {
				purpose: "summary",
				podId: prepared.podId,
				threadId: prepared.threadId,
				turnId,
			},
			maxCharacters: MAX_GENERATED_CHARACTERS,
			timeout: SUMMARY_TIMEOUT,
		});
		const result = yield* parseGenerated(answer.text, prepared.previousContent === undefined);
		return [result, answer.contextTokens] as const;
	}).pipe(
		// Each attempt gets its own time limit rather than the three sharing one.
		Models.retryUnusable,
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
): Effect.Effect<{ content: string; title?: string }, Models.UnusableAnswer> {
	const trimmed = content.trim();
	if (!trimmed) {
		return new Models.UnusableAnswer({ reason: "Thread summary model returned no text" });
	}
	if (!includeTitle) {
		return trimmed.length > MAX_THREAD_SUMMARY_CHARACTERS
			? new Models.UnusableAnswer({ reason: "Thread summary model returned too much text" })
			: Effect.succeed({ content: trimmed });
	}
	return Effect.try({
		try: () => JSON.parse(stripFence(trimmed)) as unknown,
		catch: () =>
			new Models.UnusableAnswer({ reason: "Thread summary model returned invalid JSON" }),
	}).pipe(
		Effect.flatMap((parsed) =>
			Schema.decodeUnknownEffect(firstSummarySchema)(parsed).pipe(
				Effect.mapError(
					() =>
						new Models.UnusableAnswer({
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
type SummaryFailure = Models.RequestFailure | Models.AnswerTimedOut | Models.UnusableAnswer;

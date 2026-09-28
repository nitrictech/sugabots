import { Duration, Effect, Layer } from "effect";
import type { Database } from "../../database/database.ts";
import { Models } from "../../providers/models/models.ts";
import { Turns } from "../turns/turns.ts";
import { type CompactionRequest, CompactionSteps } from "./compaction.workflow.ts";
import { Compactions, type PreparedCompaction } from "./compactions.ts";
import { compactionPrompt, MAX_COMPACTION_SUMMARY_CHARACTERS } from "./prompt.ts";

/** Longer than the Scribe's: the Compaction agent reads far more of the thread. */
const COMPACTION_TIMEOUT = Duration.minutes(5);

/** The compaction workflow's step, which its activity reaches through `CompactionSteps`. */
export const compactionStepsLayer = Layer.effect(
	CompactionSteps,
	Effect.gen(function* () {
		const model = yield* Models.Service;
		const services = yield* Effect.context<Compactions.Service | Turns.Service | Database>();
		return CompactionSteps.of({
			compact: (request) => compact(request, model).pipe(Effect.provideContext(services)),
		});
	}),
);

/**
 * Prepares, generates and records one compaction, as the Compaction agent's
 * turn. Nothing to do is not an error. A failed generation is recorded on the
 * turn and not retried: the thread's next reply past the compaction line
 * asks again.
 */
export const compact = (
	request: CompactionRequest,
	model: Models.Interface,
): Effect.Effect<void, never, Compactions.Service | Turns.Service | Database> =>
	Effect.gen(function* () {
		const compactions = yield* Compactions.Service;
		const turns = yield* Turns.Service;
		const prepared = yield* compactions.prepare(request);
		if (prepared._tag === "Skipped") return;
		yield* turns.recordSystemTurn(
			{
				...prepared.compactor,
				triggerMessageId: request.sourceMessageId,
				model: prepared.model,
				name: "compaction",
			},
			(turnId) =>
				Effect.gen(function* () {
					const [summary, contextTokens] = yield* generate(prepared, turnId, model);
					yield* compactions.complete(prepared, summary);
					return { value: undefined, contextTokens };
				}),
		);
	});

/** The model's summary, within the time and length limits. */
const generate = (
	prepared: PreparedCompaction,
	turnId: string,
	model: Models.Interface,
): Effect.Effect<
	readonly [string, contextTokens: number | undefined],
	CompactionFailure,
	Database
> =>
	Effect.gen(function* () {
		const answer = yield* model.answer({
			...compactionPrompt(prepared),
			activity: {
				purpose: "compaction",
				podId: prepared.podId,
				threadId: prepared.threadId,
				turnId,
			},
			maxCharacters: MAX_COMPACTION_SUMMARY_CHARACTERS,
			timeout: COMPACTION_TIMEOUT,
		});
		const summary = answer.text.trim();
		if (!summary) {
			return yield* new Models.UnusableAnswer({ reason: "Compaction returned no text" });
		}
		return [summary, answer.contextTokens] as const;
	}).pipe(
		// Each attempt gets its own time limit.
		Models.retryUnusable,
	);

/**
 * Why a compaction failed.
 */
type CompactionFailure = Models.RequestFailed | Models.AnswerTimedOut | Models.UnusableAnswer;

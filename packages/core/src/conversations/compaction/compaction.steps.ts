import { Cause, Data, Duration, Effect, Exit, Layer, Option } from "effect";
import type { Database } from "../../database/database.ts";
import { Models } from "../../providers/models/models.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { TurnRepository } from "../turns/repository.ts";
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
		const services = yield* Effect.context<
			Compactions.Service | TurnRepository.Service | Database
		>();
		return CompactionSteps.of({
			compact: (request) => compact(request, model).pipe(Effect.provideContext(services)),
		});
	}),
);

/**
 * Prepares, generates and records one compaction. Nothing to do is not an
 * error. A failed generation is recorded on the Compaction agent's turn and not
 * retried: the thread's next turn past the compaction line asks again.
 */
export const compact = (
	request: CompactionRequest,
	model: Models.Interface,
): Effect.Effect<void, never, Compactions.Service | TurnRepository.Service | Database> =>
	Effect.gen(function* () {
		const compactions = yield* Compactions.Service;
		const preparation = yield* compactions.prepare(request);
		if (preparation._tag === "Prepared") yield* generateCompaction(preparation, model);
	});

/**
 * Generates the summary and records how it went. As in a turn's segment, only
 * the generation may be interrupted; the outcome is always written.
 */
const generateCompaction = (
	prepared: PreparedCompaction,
	model: Models.Interface,
): Effect.Effect<void, never, Compactions.Service | TurnRepository.Service | Database> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const compactions = yield* Compactions.Service;
			const turns = yield* TurnRepository.Service;
			const generated = yield* Effect.exit(restore(generate(prepared, model)));
			if (Exit.isSuccess(generated)) {
				const [summary, accounting] = generated.value;
				return yield* compactions.complete(prepared, summary, accounting);
			}
			const cause = generated.cause;
			const expected = Cause.findErrorOption(cause);
			const failure = Option.isSome(expected)
				? expected.value
				: Cause.hasInterruptsOnly(cause)
					? new CompactionInterrupted()
					: new CompactionStoppedUnexpectedly();
			yield* failure instanceof CompactionStoppedUnexpectedly
				? Effect.logError("A compaction died", cause)
				: Effect.logWarning(`A compaction failed: ${failure.message}`);
			yield* turns.failSystemAgentTurn(prepared.turnId, failure.userMessage);
		}),
	);

/** The model's summary, within the time and length limits. */
const generate = (
	prepared: PreparedCompaction,
	model: Models.Interface,
): Effect.Effect<readonly [string, Models.Accounting], CompactionFailure, Database> =>
	Effect.gen(function* () {
		const answer = yield* model.answer({
			...compactionPrompt(prepared),
			purpose: "Compaction",
			activity: {
				purpose: "compaction",
				podId: prepared.podId,
				threadId: prepared.threadId,
				turnId: prepared.turnId,
			},
			maxCharacters: MAX_COMPACTION_SUMMARY_CHARACTERS,
			timeout: COMPACTION_TIMEOUT,
		});
		const summary = answer.text.trim();
		if (!summary) {
			return yield* new Models.UnusableAnswer({ reason: "Compaction returned no text" });
		}
		return [summary, answer.accounting] as const;
	}).pipe(
		// Each attempt gets its own time limit.
		Models.retryUnusable,
	);

/**
 * Why a compaction failed.
 */
type CompactionFailure = Models.RequestFailed | Models.AnswerTimedOut | Models.UnusableAnswer;

/** The process compacting stopped before the compaction finished. */
class CompactionInterrupted
	extends Data.TaggedError("CompactionInterrupted")
	implements UserFacing
{
	override get message() {
		return "Compaction interrupted by its process stopping";
	}
	get userMessage() {
		return UserMessage.of`The compaction was interrupted.`;
	}
}

/** A defect ended the compaction rather than any failure it expects; the defect itself is logged. */
class CompactionStoppedUnexpectedly
	extends Data.TaggedError("CompactionStoppedUnexpectedly")
	implements UserFacing
{
	override get message() {
		return "Compaction ended by a defect";
	}
	get userMessage() {
		return UserMessage.of`The compaction stopped unexpectedly.`;
	}
}

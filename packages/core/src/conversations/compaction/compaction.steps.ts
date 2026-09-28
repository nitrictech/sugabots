import { Cause, Data, Duration, Effect, Exit, Layer, Option, Ref } from "effect";
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
import { type CompactionRequest, CompactionSteps } from "./compaction.workflow.ts";
import { Compactions, type PreparedCompaction } from "./compactions.ts";
import { compactionPrompt, MAX_COMPACTION_SUMMARY_CHARACTERS } from "./prompt.ts";

/** Longer than the Scribe's: the Compaction agent reads far more of the thread. */
const COMPACTION_TIMEOUT = Duration.minutes(5);

/** The compaction workflow's step, which its activity reaches through `CompactionSteps`. */
export const stepsLayer = Layer.effect(
	CompactionSteps,
	Effect.gen(function* () {
		const model = yield* Models;
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
	model: TurnModel,
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
	model: TurnModel,
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
	model: TurnModel,
): Effect.Effect<readonly [string, ModelAccounting], CompactionFailure, Database> =>
	Effect.scoped(
		Effect.gen(function* () {
			const stop = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));

			const generated = yield* model.stream(compactionPrompt(prepared, stop.signal));
			const collected = yield* Ref.make("");
			yield* forEachDelta(generated.text, stop, (text) =>
				Ref.updateAndGet(collected, (soFar) => soFar + text).pipe(
					Effect.filterOrFail(
						(soFar) => soFar.length <= MAX_COMPACTION_SUMMARY_CHARACTERS,
						() => new UnusableAnswer({ reason: "Compaction model returned too much text" }),
					),
					Effect.asVoid,
				),
			);
			const summary = (yield* Ref.get(collected)).trim();
			if (!summary) {
				return yield* new UnusableAnswer({ reason: "Compaction model returned no text" });
			}
			const accounting = yield* generated.accounting;
			return [summary, accounting] as const;
		}),
	).pipe(
		Effect.timeoutOrElse({
			duration: COMPACTION_TIMEOUT,
			orElse: () => Effect.fail(new AnswerTimedOut({ message: "Compaction timed out" })),
		}),
		// The timeout is inside, so each attempt gets its own time.
		retryUnusable,
	);

/**
 * Why a compaction failed.
 */
type CompactionFailure = ModelRequestFailed | AnswerTimedOut | UnusableAnswer;

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

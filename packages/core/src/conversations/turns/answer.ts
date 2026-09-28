import { Data, Duration, Effect, Schedule } from "effect";
import { type UserFacing, UserMessage } from "../../user-message.ts";

/**
 * Asking a model for an answer in a particular shape, and dealing with the
 * times it does not give one.
 *
 * A model that returns prose where JSON was asked for, or a word that is not
 * one of the choices, has not failed in the way a timeout or a dead connection
 * has. It is usually a one-off, and asking again usually works. Retrying is far
 * cheaper than the alternatives: the summary job gave up after three attempts
 * spread over half a minute, each one re-reading the whole thread first, and
 * the facilitator quietly decided nobody should speak.
 *
 * Only the shape is retried here. A timeout is not — the next attempt would
 * cost the same again — and neither is anything the database or the stream
 * raised, which asking again will not change.
 */

/** The model answered, but not in a shape we can use. */
export class UnusableAnswer
	extends Data.TaggedError("UnusableAnswer")<{
		/** What was wrong with the answer. */
		readonly reason: string;
	}>
	implements UserFacing
{
	override get message() {
		return this.reason;
	}
	get userMessage() {
		return UserMessage.of`The model's answer could not be used.`;
	}
}

/** The model did not finish answering within the time allowed. */
export class AnswerTimedOut
	extends Data.TaggedError("AnswerTimedOut")<{
		/** Which answer, and the limit it ran past. */
		readonly message: string;
	}>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The model did not answer in time.`;
	}
}

/**
 * Three attempts, a moment apart.
 *
 * Short, because each attempt is a model call somebody is waiting on, and
 * because a prompt the model cannot follow will not start working on the tenth
 * try — that is a prompt to fix, not a failure to absorb. The small gap is
 * jittered so a wave of threads hitting the same bad patch does not re-ask in
 * lockstep.
 */
export const RETRY_UNUSABLE = Schedule.recurs(2).pipe(
	Schedule.addDelay(() => Effect.succeed(Duration.millis(250))),
	Schedule.jittered,
);

/**
 * Asks again when the answer was the wrong shape, and gives up on anything
 * else. What the caller does after the last attempt is its own business:
 * falling back to a safe default, or recording the failure.
 */
export const retryUnusable = <A, E, R>(ask: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.retry(ask, {
		while: (failure: E) => failure instanceof UnusableAnswer,
		schedule: RETRY_UNUSABLE,
	});

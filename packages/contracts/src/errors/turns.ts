/**
 * The errors the turns operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/**
 * A newer execution of the turn has taken it over, as when its workflow
 * resumed it in another process while this one still ran a step, so this
 * execution records nothing more and stops.
 */
export class TurnExecutionSuperseded
	extends Schema.TaggedError<TurnExecutionSuperseded>()("TurnExecutionSuperseded", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A newer execution of the turn has taken it over";
	}
	get userMessage() {
		return userText`This turn carried on elsewhere, so this run of it stopped`;
	}
}

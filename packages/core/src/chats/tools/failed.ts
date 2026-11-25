import { type DomainError, UserText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** What the bot is told when a tool couldn't do its work. */
export interface Failed {
	readonly status: "failed";
	readonly error: UserText;
}

export const failed = (error: UserText): Failed => ({ status: "failed", error });

export class ToolCallError
	extends Schema.TaggedError<ToolCallError>()("ToolCallError", { userMessage: UserText.schema })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return this.userMessage;
	}
}

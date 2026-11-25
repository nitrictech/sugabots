import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

export class WebToolOff
	extends Schema.TaggedError<WebToolOff>()("WebToolOff", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Web access is off for the workspace or bot";
	}
	get userMessage() {
		return userText`This tool is turned off for this bot.`;
	}
}

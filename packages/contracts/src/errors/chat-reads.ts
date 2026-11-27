/**
 * The errors the chat-reads operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** A page's cursor is not one a page handed out. */
export class InvalidCursor
	extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A page cursor was not one a page handed out";
	}
	get userMessage() {
		return userText`That page cursor is invalid`;
	}
}

/**
 * No file in the chat has the id asked for, or it is one members don't read
 * there, such as an unsent attachment; or the chat was deleted while it was read.
 */
export class ChatFileNotFound
	extends Schema.TaggedError<ChatFileNotFound>()("ChatFileNotFound", { fileId: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `No file "${this.fileId}" to read in the chat`;
	}
	get userMessage() {
		return userText`That file isn't there`;
	}
}

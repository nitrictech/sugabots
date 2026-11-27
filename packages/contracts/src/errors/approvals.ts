/**
 * The errors the approvals operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** The tool call waits for no decision: it asked for none, was decided, or its turn ended. */
export class ToolApprovalNotFound
	extends Schema.TaggedError<ToolApprovalNotFound>()("ToolApprovalNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The tool call waits for no decision";
	}
	get userMessage() {
		return userText`No such pending tool approval`;
	}
}

/** Somebody decided the tool call first, and the first decision recorded stands. */
export class ToolApprovalConflict
	extends Schema.TaggedError<ToolApprovalConflict>()("ToolApprovalConflict", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The tool call was already decided";
	}
	get userMessage() {
		return userText`That tool approval has already been decided`;
	}
}

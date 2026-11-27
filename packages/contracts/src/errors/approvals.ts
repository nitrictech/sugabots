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

/** The approval was already decided or its call changed before it could be allowed. */
export class ToolApprovalConflict
	extends Schema.TaggedError<ToolApprovalConflict>()("ToolApprovalConflict", {
		reason: Schema.optional(
			Schema.Literals([
				"briefDestinationChanged",
				"connectorChanged",
				"noComputerProvider",
				"computerUseChanged",
				"hostBlocked",
			]),
		),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return this.reason
			? `The tool approval was invalidated: ${this.reason}`
			: "The tool call was already decided";
	}
	get userMessage() {
		switch (this.reason) {
			case "briefDestinationChanged":
				return userText`This approval was closed because the chat the bot wanted to start changed.`;
			case "connectorChanged":
				return userText`This approval was closed because the connector or its tool settings changed.`;
			case "noComputerProvider":
				return userText`This approval was closed because the workspace has no enabled computer provider.`;
			case "computerUseChanged":
				return userText`This approval was closed because the bot can no longer use the computer.`;
			case "hostBlocked":
				return userText`This approval was closed because the workspace now blocks the requested host.`;
			default:
				return userText`That tool approval has already been decided`;
		}
	}
}

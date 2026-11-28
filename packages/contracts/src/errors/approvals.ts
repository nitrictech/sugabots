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

export const approvalSettingsChangeSchema = Schema.Literals([
	"briefDestinationChanged",
	"automationRoutineChanged",
	"automationRoutineTimeZoneChanged",
	"automationRemoved",
	"botCanNoLongerJoinProject",
	"botCanNoLongerLeadProject",
	"connectorChanged",
	"connectorOff",
	"toolSwitchedOff",
	"noComputerProvider",
	"computerUseChanged",
	"computerTargetChanged",
	"hostBlocked",
]);

/** The approval was already decided or its call changed before it could be allowed. */
export class ToolApprovalConflict
	extends Schema.TaggedError<ToolApprovalConflict>()("ToolApprovalConflict", {
		reason: Schema.optional(approvalSettingsChangeSchema),
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
			case "automationRoutineChanged":
				return userText`This approval was closed because the automation's routine changed.`;
			case "automationRoutineTimeZoneChanged":
				return userText`This approval was closed because the workspace time zone changed. Ask the bot to try again.`;
			case "automationRemoved":
				return userText`This approval was closed because the automation was removed.`;
			case "botCanNoLongerJoinProject":
				return userText`This approval was closed because that bot can't join this project. Add a public bot instead.`;
			case "botCanNoLongerLeadProject":
				return userText`This approval was closed because that bot can't lead the requested project. Choose a different lead bot.`;
			case "connectorChanged":
				return userText`This approval was closed because the connector or its tool settings changed.`;
			case "connectorOff":
				return userText`This approval was closed because the connector or its tool is now off.`;
			case "toolSwitchedOff":
				return userText`This approval was closed because the tool is now off.`;
			case "noComputerProvider":
				return userText`This approval was closed because the workspace has no enabled computer provider.`;
			case "computerTargetChanged":
				return userText`This approval was closed because the computer the bot wanted to use changed.`;
			case "computerUseChanged":
				return userText`This approval was closed because the bot can no longer use the computer.`;
			case "hostBlocked":
				return userText`This approval was closed because the workspace now blocks the requested host.`;
			default:
				return userText`That tool approval has already been decided`;
		}
	}
}

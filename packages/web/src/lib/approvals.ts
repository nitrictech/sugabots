import { APPROVAL_LIFETIME_DAYS, type ChatDetails, type ToolCallPart } from "@sugabots/contracts";
import { ToolApprovalConflict } from "@sugabots/contracts/errors/approvals";

/** What a member may decide in a chat, as its details say. */
export type ApprovalPermissions = NonNullable<ChatDetails["permissions"]>;

/**
 * Whether the member may answer `call`'s approval, made in the reply
 * `replyId`: whether they approve that reply's calls, or, for a request to
 * change the computer the bot works on, whether they manage that computer,
 * which is the chat's project's.
 */
export function mayAnswer(
	call: ToolCallPart,
	replyId: string,
	permissions: ApprovalPermissions | undefined,
) {
	return call.approval?.approvers === "computer-managers"
		? (permissions?.approveComputerRequests ?? false)
		: (permissions?.approveToolCallsIn.includes(replyId) ?? false);
}

/** Who a member who may not answer `call` is waiting for. */
export function awaitedApprovers(call: ToolCallPart) {
	return call.approval?.approvers === "computer-managers"
		? "The workspace's owner or an admin can decide. In a bot's own chats, whoever made the bot can too."
		: "Waiting for someone with permission to answer this.";
}

export function routineChangeMessage(
	change: NonNullable<ToolCallPart["approval"]>["routineChange"],
) {
	switch (change) {
		case "add":
			return "Adds the automation's first routine.";
		case "replace":
			return "Replaces the automation's existing routine.";
		default:
			return undefined;
	}
}

export function closedApprovalMessage(call: ToolCallPart, botName: string): string {
	const reason = call.approval?.closedBecause;
	switch (reason) {
		case "newMessage":
			return `No longer waiting. A new message reached ${botName}.`;
		case "botStopped":
			return `No longer waiting. ${botName} was stopped.`;
		case "approvalExpired":
			return `No longer waiting. Nobody answered within ${APPROVAL_LIFETIME_DAYS} days. Ask ${botName} to try again.`;
		case "automationRunEnded":
			return "No longer waiting. The automation run ended. Start a new run if you still need this done.";
		case "chatUnavailable":
			return `No longer waiting. This chat is no longer available. If you can still talk to ${botName}, start a new chat.`;
		case "replyFailed":
			return `No longer waiting. ${botName} couldn't finish. Check what ${botName} already did before asking again.`;
		case "withdrawn":
		case undefined:
			return "No longer waiting for approval.";
		default: {
			const message = new ToolApprovalConflict({ reason }).userMessage;
			return `${message.replaceAll("the bot", () => botName)} Ask ${botName} to try again.`;
		}
	}
}

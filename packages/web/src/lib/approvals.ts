import type { ChatDetails, ToolCallPart } from "@sugabots/contracts";

/** What a member may decide in a chat, as its details say. */
export type ApprovalPermissions = NonNullable<ChatDetails["permissions"]>;

/**
 * Whether the member may answer `call`'s approval: the chat's approvals, or,
 * for a request to change the computer the bot works on, whether they manage
 * that computer, which is the chat's project's.
 */
export function mayAnswer(call: ToolCallPart, permissions: ApprovalPermissions | undefined) {
	return call.approval?.approvers === "computer-managers"
		? (permissions?.approveComputerRequests ?? false)
		: (permissions?.approveToolCalls ?? false);
}

/** Who a member who may not answer `call` is waiting for. */
export function awaitedApprovers(call: ToolCallPart) {
	return call.approval?.approvers === "computer-managers"
		? "Waiting for someone who manages this computer to answer this."
		: "Waiting for someone with permission to answer this.";
}

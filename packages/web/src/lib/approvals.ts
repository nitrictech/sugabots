import type { ChatDetails, ToolCallPart } from "@sugabots/contracts";

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

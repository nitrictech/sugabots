import type { ChatDetails, ToolCallPart } from "@sugabots/contracts";

/** What a person may decide in a chat, as its details say. */
export type ApprovalCapabilities = NonNullable<ChatDetails["capabilities"]>;

/**
 * Whether the person may answer `call`'s approval, which the bot `botId`
 * raised: the chat's approvals, or, for a request to change the
 * computer that bot works on, whether they manage that computer, which is its
 * project's: the chat's project, or in a collaboration the bot's
 * default project.
 */
export function mayAnswer(
	call: ToolCallPart,
	botId: string,
	capabilities: ApprovalCapabilities | undefined,
) {
	return call.approval?.approvers === "computer-managers"
		? (capabilities?.approveComputerRequestsOf?.includes(botId) ?? false)
		: (capabilities?.approveToolCalls ?? false);
}

/** Who a person who may not answer `call` is waiting for. */
export function awaitedApprovers(call: ToolCallPart) {
	return call.approval?.approvers === "computer-managers"
		? "Waiting for someone who manages this computer to answer this."
		: "Waiting for someone with permission to answer this.";
}

import type { ThreadDetails, ToolCallPart } from "@sugabots/contracts";

/** What a person may decide in a thread, as the thread's details say. */
export type ApprovalCapabilities = NonNullable<ThreadDetails["capabilities"]>;

/**
 * Whether the person may answer `call`'s approval, which the bot `agentId`
 * raised: the thread's approvals, or, for a request to change that bot's
 * computer, whether they manage the bot.
 */
export function mayAnswer(
	call: ToolCallPart,
	agentId: string,
	capabilities: ApprovalCapabilities | undefined,
) {
	return call.approval?.deciders === "sandbox-managers"
		? (capabilities?.approveSandboxRequestsOf?.includes(agentId) ?? false)
		: (capabilities?.approveToolCalls ?? false);
}

/** Who a person who may not answer `call` is waiting for. */
export function awaitedDeciders(call: ToolCallPart) {
	return call.approval?.deciders === "sandbox-managers"
		? "Waiting for an admin of this pod to answer this."
		: "Waiting for someone with permission to answer this.";
}

import type { ThreadDetails, ToolCallPart } from "@sugabots/contracts";

/** What a person may decide in a thread, as the thread's details say. */
export type ApprovalCapabilities = NonNullable<ThreadDetails["capabilities"]>;

/**
 * Whether the person may answer `call`'s approval: the pod's approvals, or,
 * for a request to change the pod's sandbox, whether they manage it.
 */
export function mayAnswer(call: ToolCallPart, capabilities: ApprovalCapabilities | undefined) {
	return call.approval?.deciders === "sandbox-managers"
		? (capabilities?.approveSandboxRequests ?? false)
		: (capabilities?.approveToolCalls ?? false);
}

/** Who a person who may not answer `call` is waiting for. */
export function awaitedDeciders(call: ToolCallPart) {
	return call.approval?.deciders === "sandbox-managers"
		? "Waiting for an admin of this pod to answer this."
		: "Waiting for someone with permission to answer this.";
}

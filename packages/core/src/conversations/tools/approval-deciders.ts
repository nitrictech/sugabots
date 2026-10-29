import type { ToolApprovalDeciders } from "@sugabots/contracts";
import { ASK_FORM_TOOL } from "./ask-form/tool.ts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "./network-access/tool.ts";

/**
 * The tools whose calls ask to change the pod's sandbox, such as what it may
 * reach, which those who manage the pod's sandbox decide.
 */
export const SANDBOX_REQUEST_TOOLS: readonly string[] = [REQUEST_NETWORK_ACCESS_TOOL];

/**
 * Who decides a call to `tool` that waits for approval: those who manage the
 * pod's sandbox for one of {@link SANDBOX_REQUEST_TOOLS}, anyone taking part
 * in the thread for a form, which they decide by answering it, and the pod's
 * approvers for everything else.
 */
export function decidersOf(tool: string): ToolApprovalDeciders {
	if (tool === ASK_FORM_TOOL) return "thread";
	return SANDBOX_REQUEST_TOOLS.includes(tool) ? "sandbox-managers" : "pod";
}

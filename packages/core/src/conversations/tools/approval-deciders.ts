import type { ToolApprovalDeciders } from "@sugabots/contracts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "./network-access/tool.ts";
import { REQUEST_SOFTWARE_TOOL } from "./software/tool.ts";

/**
 * The tools whose calls ask to change the pod's sandbox, such as what it may
 * reach or what software it has, which those who manage the pod's sandbox
 * decide.
 */
export const SANDBOX_REQUEST_TOOLS: readonly string[] = [
	REQUEST_NETWORK_ACCESS_TOOL,
	REQUEST_SOFTWARE_TOOL,
];

/**
 * Who decides a call to `tool` that waits for approval: those who manage the
 * pod's sandbox for one of {@link SANDBOX_REQUEST_TOOLS}, and the pod's
 * approvers for everything else.
 */
export function decidersOf(tool: string): ToolApprovalDeciders {
	return SANDBOX_REQUEST_TOOLS.includes(tool) ? "sandbox-managers" : "pod";
}

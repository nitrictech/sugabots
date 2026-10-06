import type { ToolApprovalDeciders } from "@sugabots/contracts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "./network-access/tool.ts";
import { REQUEST_SOFTWARE_TOOL } from "./software/tool.ts";

/**
 * Who decides a call to `tool` that waits for approval. A request for network
 * access or software changes the pod's sandbox, so those who manage it decide
 * it; the pod's approvers decide everything else.
 */
export function decidersOf(tool: string): ToolApprovalDeciders {
	return tool === REQUEST_NETWORK_ACCESS_TOOL || tool === REQUEST_SOFTWARE_TOOL
		? "sandbox-managers"
		: "pod";
}

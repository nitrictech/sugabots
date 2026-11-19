import type { ToolApprovalDeciders } from "@sugabots/contracts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "./network-access/tool.ts";

/**
 * The tools whose calls ask to change the computer the turn works on, such as
 * what it may reach, which those who manage that computer's project decide.
 */
export const COMPUTER_REQUEST_TOOLS: readonly string[] = [REQUEST_NETWORK_ACCESS_TOOL];

/**
 * Who decides a call to `tool` that waits for approval: those who manage the
 * project whose computer the turn works on (the conversation's, or in a
 * collaboration the collaborating bot's default project) for one of
 * {@link COMPUTER_REQUEST_TOOLS}, and the approvers
 * of the conversation it was raised in for everything else.
 */
export function decidersOf(tool: string): ToolApprovalDeciders {
	return COMPUTER_REQUEST_TOOLS.includes(tool) ? "computer-managers" : "conversation";
}

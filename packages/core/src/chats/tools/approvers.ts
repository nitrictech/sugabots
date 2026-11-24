import type { ToolApprovers } from "@sugabots/contracts";
import { HOST_REQUEST_TOOL } from "./host-request/tool.ts";

/**
 * The tools whose calls ask to change the computer the turn works on, such as
 * what it may reach, which those who manage that computer's project decide.
 */
export const COMPUTER_REQUEST_TOOLS: readonly string[] = [HOST_REQUEST_TOOL];

/**
 * Who decides a call to `tool` that waits for approval: those who manage the
 * project whose computer the turn works on, the chat's, for one of
 * {@link COMPUTER_REQUEST_TOOLS}, and the approvers of the chat it was raised
 * in for everything else.
 */
export function approversOf(tool: string): ToolApprovers {
	return COMPUTER_REQUEST_TOOLS.includes(tool) ? "computer-managers" : "chat";
}

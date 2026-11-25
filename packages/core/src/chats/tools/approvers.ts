import type { JsonValue, ToolApprovers } from "@sugabots/contracts";
import { HOST_REQUEST_TOOL } from "@sugabots/contracts";
import { botLoopTools, manifest } from "@sugabots/contracts/operations";
import { computersContracts } from "@sugabots/contracts/operations/computers";
import { Schema } from "effect";

/**
 * The tools whose calls ask to change the computer the turn works on, such as
 * what it may reach, which those who manage that computer's project decide:
 * the operations whose exposure says those approve them.
 */
export const COMPUTER_REQUEST_TOOLS: readonly string[] = botLoopTools(manifest).flatMap(
	({ approval, tool }) =>
		approval.kind === "always" && approval.approvers === "computerManagers" ? [tool] : [],
);

/**
 * Who decides a call to `tool` that waits for approval, as a tool call part
 * says it: those who manage the project whose computer the request names, for one of {@link COMPUTER_REQUEST_TOOLS}, and the approvers of the
 * turn that made it for everything else (see `proofs/approvers.ts`).
 */
export function approversOf(tool: string): ToolApprovers {
	return COMPUTER_REQUEST_TOOLS.includes(tool) ? "computer-managers" : "chat";
}

/** The validated host field that may be shown to a computer approver outside the chat. */
export function fixedApprovalInput(call: {
	tool: string;
	input: JsonValue;
	executionInput: JsonValue | null;
}): JsonValue {
	if (call.tool !== HOST_REQUEST_TOOL) return null;
	const request = Schema.decodeUnknownOption(computersContracts["computers.requestHost"].input)(
		call.executionInput ?? call.input,
	);
	return request._tag === "Some" ? { host: request.value.host } : null;
}

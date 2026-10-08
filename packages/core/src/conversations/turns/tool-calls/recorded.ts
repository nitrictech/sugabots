import { type UserText, userText } from "@sugabots/errors";
import type { Tool } from "ai";
import { Effect } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { ApprovedToolCalls } from "../approvals/approved-calls.ts";
import type { ToolCallRepository } from "./repository.ts";

/** The turn a recorded tool runs in: where its rows point. */
export interface RecordingTurn {
	threadId: string;
	messageId: string;
	turnId: string;
}

export interface RecordingOptions {
	calls: Pick<ToolCallRepository.Interface, "open" | "close">;
	/** Runs a service's Effect from the tool's promise. */
	run: RunEffect;
	from: RecordingTurn;
	/** How much of the reply has been written so far, which is where the call sits. */
	replyLength: () => number;
	/** Tells the running turn a call was made, so the reply's parts include it from now on. */
	noteToolCall: (call: { id: string; atOffset: number; mutating: boolean }) => Effect.Effect<void>;
	/** Marks the external mutation boundary, after approval and before dispatch. */
	markActed?: () => Effect.Effect<void>;
	/** Whether the tool may change something at the other end. Built-in tools do not. */
	mutating?: boolean;
	approval?: {
		approvals: Pick<ApprovedToolCalls.Interface, "beginExecution">;
		binding: ToolCallRepository.ApprovalBinding;
	};
}

/** What the model is told when a tool did not give a result, in place of the result. */
export interface ToolFailedResult {
	status: "failed";
	error: UserText;
}

/** What people, and the model, are told of a tool that threw. */
const TOOL_THREW = userText`The tool failed before it finished.`;

/**
 * What the model is told of an approved call that may no longer run, such as
 * one whose connection changed after it was approved.
 */
const APPROVAL_NO_LONGER_APPLIES = userText`The tool was not run: its approval no longer applies.`;

/**
 * A tool whose every call is written down: opened with its input before it
 * runs, closed with its output or error after.
 *
 * A tool that throws is recorded as failed and the model is told so as an
 * ordinary result, so the agent can recover or explain rather than
 * the turn dying. The SDK's own tool-error path would also reach the model,
 * but through a shape this codebase does not otherwise handle, and with
 * whatever text was thrown.
 */
export function recorded(key: string, tool: Tool, options: RecordingOptions): Tool {
	const execute = tool.execute;
	if (!execute) {
		return tool;
	}
	const {
		calls,
		run,
		from,
		replyLength,
		noteToolCall,
		markActed,
		mutating = false,
		approval,
	} = options;
	return {
		...tool,
		execute: async (input, callOptions) => {
			const atOffset = replyLength();
			const opening = approval
				? approval.approvals
						.beginExecution({
							...from,
							sdkToolCallId: callOptions.toolCallId,
							tool: key,
							input,
							atOffset,
							binding: approval.binding,
						})
						.pipe(
							Effect.catchTag("ToolExecutionRefused", (refused) =>
								Effect.as(
									Effect.logWarning(`Approved tool ${key} was not run: ${refused.message}`),
									undefined,
								),
							),
						)
				: calls.open({ ...from, tool: key, input, atOffset, mutating });
			const opened = await run(opening);
			if (!opened) {
				return { status: "failed", error: APPROVAL_NO_LONGER_APPLIES } satisfies ToolFailedResult;
			}
			await run(noteToolCall({ id: opened.id, atOffset, mutating }));
			try {
				if (mutating && markActed) await run(markActed());
				const output = await execute(input, callOptions);
				await run(calls.close(opened.id, { output }));
				return output;
			} catch (cause) {
				// A tool with a failure worth explaining returns it as its result. A
				// throw is a fault in the tool or its connection: what was thrown
				// goes to the logs, and people are told only that the call failed.
				await run(Effect.logError(`Tool ${key} threw`, cause));
				await run(calls.close(opened.id, { error: TOOL_THREW }));
				return { status: "failed", error: TOOL_THREW } satisfies ToolFailedResult;
			}
		},
	};
}

/**
 * A tool that is offered but never runs: each call is recorded as failed with
 * `reason`, which the model is told as the call's result.
 */
export function refused(
	key: string,
	tool: Tool,
	reason: UserText,
	options: Pick<RecordingOptions, "calls" | "run" | "from" | "replyLength" | "noteToolCall">,
): Tool {
	const { calls, run, from, replyLength, noteToolCall } = options;
	return {
		...tool,
		execute: async (input) => {
			const atOffset = replyLength();
			const opened = await run(
				calls.open({ ...from, tool: key, input, atOffset, mutating: false }),
			);
			await run(noteToolCall({ id: opened.id, atOffset, mutating: false }));
			await run(calls.close(opened.id, { error: reason }));
			return { status: "failed", error: reason } satisfies ToolFailedResult;
		},
	};
}

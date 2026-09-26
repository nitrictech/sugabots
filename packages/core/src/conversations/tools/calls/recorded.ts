import type { Tool } from "ai";
import type { Effect } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import { describeFailure } from "../../jobs/worker.ts";
import type { ToolApprovalStore } from "../approvals/store.ts";
import type { ToolCallStore } from "./store.ts";

/** The turn a recorded tool runs in: where its rows point. */
export interface RecordingTurn {
	threadId: string;
	messageId: string;
	turnId: string;
}

export interface RecordingOptions {
	calls: ToolCallStore;
	/** Runs a store Effect from the tool's promise. */
	run: RunEffect;
	from: RecordingTurn;
	/** How much of the reply has been written so far, which is where the call sits. */
	replyLength: () => number;
	/** Tells the worker a call was made, so the reply's parts include it from now on. */
	noteToolCall: (call: { id: string; atOffset: number; mutating: boolean }) => Effect.Effect<void>;
	/** Marks the external mutation boundary, after approval and before dispatch. */
	markActed?: () => Effect.Effect<void>;
	/** Whether the tool may change something at the other end (ADR 002). Built-in tools do not. */
	mutating?: boolean;
	approval?: {
		store: ToolApprovalStore;
		connectionId: string;
		connectionRevision: number;
		remoteToolName: string;
	};
}

/** What the model is told when a tool throws, in place of the result it did not get. */
export interface ToolFailedResult {
	status: "failed";
	error: string;
}

/**
 * A tool whose every call is written down: opened with its input before it
 * runs, closed with its output or error after.
 *
 * A tool that throws is recorded as failed and the model is told so as an
 * ordinary result (ADR 002), so the agent can recover or explain rather than
 * the turn dying. The SDK's own tool-error path would also reach the model,
 * but through a shape this codebase does not otherwise handle.
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
			const opened = approval
				? await run(
						approval.store.beginExecution({
							...from,
							sdkToolCallId: callOptions.toolCallId,
							tool: key,
							input,
							atOffset,
							connectionId: approval.connectionId,
							connectionRevision: approval.connectionRevision,
							remoteToolName: approval.remoteToolName,
						}),
					)
				: await run(calls.open({ ...from, tool: key, input, atOffset, mutating }));
			await run(noteToolCall({ id: opened.id, atOffset, mutating }));
			try {
				if (mutating && markActed) await run(markActed());
				const output = await execute(input, callOptions);
				await run(calls.close(opened.id, { output }));
				return output;
			} catch (cause) {
				const error = describeFailure(cause);
				await run(calls.close(opened.id, { error }));
				return { status: "failed", error } satisfies ToolFailedResult;
			}
		},
	};
}

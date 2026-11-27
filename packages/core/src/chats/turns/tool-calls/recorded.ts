import { type UserText, userText } from "@sugabots/errors";
import type { Tool } from "ai";
import { Effect } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import { ToolCallError } from "../../tools/failed.ts";
import { withRecordedCall } from "../../tools/recorded-call.ts";
import type { ApprovalAsked, ApprovalBinding, CallRecord } from "../loop-values.ts";
import type { ToolCallRecorder } from "../tools.ts";
import { APPROVAL_NO_LONGER_APPLIES, INTERRUPTED_CALL } from "./lifecycle.ts";
import { forModel, type ResultFiles } from "./long-results.ts";

export interface RecordingOptions {
	/** Where the turn's calls are written down: the bot loop's own records of them. */
	recorder: ToolCallRecorder;
	/** Where a result too long to give the model whole is kept, for it to read on. */
	files: ResultFiles;
	/** Runs a service's Effect from the tool's promise. */
	run: RunEffect;
	/** The chat the turn is in, where a long result is kept. */
	chatId: string;
	/** Whether the tool may change something at the other end. Built-in tools do not. */
	writeOrDelete?: boolean;
	/** The tool the call is bound to: a connector's, as configured now; a built-in one when unset. */
	binding?: ApprovalBinding;
	/** For a call that waited for approval: what it must still match to run. */
	approval?: { binding: ApprovalBinding };
}

/** What the model is told when a tool did not give a result, in place of the result. */
interface ToolFailedResult {
	status: "failed";
	error: UserText;
}

/** What members, and the model, are told of a tool that threw. */
export const TOOL_THREW = userText`The tool failed before it finished.`;
export const READ_INTERRUPTED = userText`The tool stopped before it finished.`;

export const RESULT_NOT_GIVEN = userText`The tool finished, but its result could not be given to you.`;

async function recordedResult(
	call: Exclude<CallRecord, { _tag: "Send" }>,
	{ files, run, chatId }: Pick<RecordingOptions, "files" | "run" | "chatId">,
): Promise<unknown> {
	if (call._tag !== "Finished") return { status: "failed", error: call.error };
	if ("error" in call.outcome) return { status: "failed", error: call.outcome.error };
	return run(forModel(call.outcome.output, { files, chatId, toolCallId: call.id }));
}

// biome-ignore lint/plugin/errors-implement-domain-error: The loop catches this signal to ask for approval again.
export class ToolApprovalRequired extends Error {
	readonly asked: ApprovalAsked & { readonly reopenCallId: string };

	constructor(asked: ApprovalAsked & { readonly reopenCallId: string }) {
		super("The tool requires a new approval");
		this.asked = asked;
	}
}

/**
 * A tool whose every call is written down: recorded as sent with its input
 * before it runs, which marks the turn as having acted when the tool may
 * change something, and finished with its output or error after.
 *
 * The call's row keeps the whole output. The model is given it whole too,
 * unless it is longer than `MAX_RESULT_CHARACTERS`: then it is kept as a
 * file in the chat and the model gets its start (see `long-results.ts`).
 *
 * A tool that throws is recorded as failed and the model is told so as an
 * ordinary result, so the bot can recover or explain rather than
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
		recorder,
		files,
		run,
		chatId,
		writeOrDelete = false,
		binding = { kind: "built-in" },
		approval,
	} = options;
	return {
		...tool,
		execute: async (input, callOptions) => {
			const opening = approval
				? recorder.startApproved({
						toolCallId: callOptions.toolCallId,
						tool: key,
						input,
						binding: approval.binding,
						writeOrDelete,
					})
				: recorder.open({
						toolCallId: callOptions.toolCallId,
						tool: key,
						input,
						writeOrDelete,
						binding,
					});
			const recorded = await run(opening);
			if (!recorded) {
				await run(
					Effect.logWarning(`Approved tool ${key} was not run: its approval no longer holds`),
				);
				return { status: "failed", error: APPROVAL_NO_LONGER_APPLIES } satisfies ToolFailedResult;
			}
			if (recorded._tag !== "Send") return recordedResult(recorded, options);
			const opened = recorded.id;
			let output: unknown;
			try {
				// The record's id stays the call's when it is sent again, so a destination
				// that takes an idempotency key can be given it.
				output = await execute(input, {
					...callOptions,
					context: withRecordedCall(callOptions.context, opened),
				});
				if (writeOrDelete) callOptions.abortSignal?.throwIfAborted();
				await run(recorder.close(opened, { output }));
			} catch (cause) {
				if (cause instanceof ToolApprovalRequired) return cause;
				const interrupted = callOptions.abortSignal?.aborted;
				if (interrupted || !(cause instanceof ToolCallError))
					await run(Effect.logError(`Tool ${key} threw`, cause));
				const interruptedMessage = writeOrDelete ? INTERRUPTED_CALL : READ_INTERRUPTED;
				const error = interrupted
					? interruptedMessage
					: cause instanceof ToolCallError
						? cause.userMessage
						: TOOL_THREW;
				await run(recorder.close(opened, { error }));
				return { status: "failed", error } satisfies ToolFailedResult;
			}
			try {
				return await run(forModel(output, { files, chatId, toolCallId: opened }));
			} catch (cause) {
				// The call is already finished with its output, which stays: only
				// the model goes without it.
				await run(Effect.logError(`Giving tool ${key}'s result to the model failed`, cause));
				return { status: "failed", error: RESULT_NOT_GIVEN } satisfies ToolFailedResult;
			}
		},
	};
}

/**
 * refused returns a tool that records new calls as failed with `reason`.
 * Calls that already finished or were interrupted return their recorded result.
 */
export function refused(
	key: string,
	tool: Tool,
	reason: UserText,
	options: Pick<RecordingOptions, "recorder" | "run" | "files" | "chatId">,
): Tool {
	const { recorder, run } = options;
	return {
		...tool,
		execute: async (input, callOptions) => {
			const recorded = await run(
				recorder.open({
					toolCallId: callOptions.toolCallId,
					tool: key,
					input,
					writeOrDelete: false,
					binding: { kind: "built-in" },
				}),
			);
			if (recorded._tag === "Finished" || recorded._tag === "Interrupted") {
				return recordedResult(recorded, options);
			}
			if (recorded._tag === "Send") await run(recorder.close(recorded.id, { error: reason }));
			return { status: "failed", error: reason } satisfies ToolFailedResult;
		},
	};
}

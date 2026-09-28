import { tool } from "ai";
import { Effect, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { effectRunner } from "../../../database/database.ts";
import { noDatabase } from "../../../database/testing.ts";
import { noToolApprovalStore, ToolExecutionRefused } from "../approvals/store.ts";
import { recorded } from "./recorded.ts";
import type { ToolCallStore } from "./store.ts";

/**
 * The wrapper against a fake store: what it writes before and after the tool
 * runs, and what the model is told when the tool throws or may not run.
 */

const run = effectRunner(ManagedRuntime.make(noDatabase));
const callId = "0199a3a0-0000-7000-8000-0000000000aa";
const from = {
	threadId: "0199a3a0-0000-7000-8000-000000000001",
	messageId: "0199a3a0-0000-7000-8000-000000000012",
	turnId: "0199a3a0-0000-7000-8000-000000000011",
};
const callOptions = { toolCallId: "sdk-1", messages: [] } as never;

function store(): ToolCallStore {
	return {
		open: vi.fn(({ atOffset, tool, input, mutating }) =>
			Effect.succeed({
				type: "tool_call" as const,
				id: callId,
				tool,
				input: input as never,
				output: null,
				status: "running" as const,
				error: null,
				mutating: mutating ?? false,
				atOffset,
				startedAt: "2026-09-14T00:00:00.000Z",
				finishedAt: null,
			}),
		),
		close: vi.fn(() => Effect.undefined),
	};
}

describe("a recorded tool", () => {
	it("opens the call with its input where the reply stands, then closes it with the output", async () => {
		const calls = store();
		const noted: Array<{ id: string; atOffset: number; mutating: boolean }> = [];
		const probe = recorded(
			"probe",
			tool({
				inputSchema: Schema.Struct({ q: Schema.String }).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute: async ({ q }) => ({ answer: q.toUpperCase() }),
			}),
			{
				calls,
				run,
				from,
				replyLength: () => 9,
				noteToolCall: (call) => Effect.sync(() => void noted.push(call)),
			},
		);

		const output = await probe.execute?.({ q: "hi" }, callOptions);

		expect(output).toEqual({ answer: "HI" });
		expect(calls.open).toHaveBeenCalledWith({
			...from,
			tool: "probe",
			input: { q: "hi" },
			atOffset: 9,
			mutating: false,
		});
		expect(noted).toEqual([{ id: callId, atOffset: 9, mutating: false }]);
		expect(calls.close).toHaveBeenCalledWith(callId, { output: { answer: "HI" } });
	});

	it("marks a call as acting when the tool changes things, in the row and in the reply", async () => {
		const calls = store();
		const noted: Array<{ mutating: boolean }> = [];
		const probe = recorded(
			"wiki__wipe",
			tool({
				inputSchema: Schema.Struct({}).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute: async () => "gone",
			}),
			{
				calls,
				run,
				from,
				replyLength: () => 0,
				noteToolCall: (call) => Effect.sync(() => void noted.push(call)),
				mutating: true,
			},
		);

		await probe.execute?.({}, callOptions);

		expect(calls.open).toHaveBeenCalledWith(expect.objectContaining({ mutating: true }));
		expect(noted).toEqual([expect.objectContaining({ mutating: true })]);
	});

	it("records that a tool threw, but not what it threw", async () => {
		const calls = store();
		const probe = recorded(
			"probe",
			tool({
				inputSchema: Schema.Struct({}).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute: async (): Promise<{ ok: boolean }> => {
					throw new Error("upstream said no");
				},
			}),
			{ calls, run, from, replyLength: () => 0, noteToolCall: () => Effect.void },
		);

		const output = await probe.execute?.({}, callOptions);

		// What was thrown goes to the logs, not to people or the model.
		expect(output).toEqual({ status: "failed", error: "The tool failed before it finished." });
		expect(calls.close).toHaveBeenCalledWith(callId, {
			error: "The tool failed before it finished.",
		});
	});

	it("does not run an approved call its approval no longer covers, nor tell the model why", async () => {
		const calls = store();
		const execute = vi.fn(async () => ({ ok: true }));
		const probe = recorded(
			"probe",
			tool({
				inputSchema: Schema.Struct({}).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute,
			}),
			{
				calls,
				run,
				from,
				replyLength: () => 0,
				noteToolCall: () => Effect.void,
				approval: {
					store: {
						...noToolApprovalStore,
						beginExecution: () =>
							Effect.fail(
								new ToolExecutionRefused({
									message: "Connection configuration changed after approval",
								}),
							),
					},
					connectionId: "0199a3a0-0000-7000-8000-000000000021",
					connectionRevision: 1,
					remoteToolName: "probe",
				},
			},
		);

		const output = await probe.execute?.({}, callOptions);

		expect(output).toEqual({
			status: "failed",
			error: "The tool was not run: its approval no longer applies.",
		});
		expect(execute).not.toHaveBeenCalled();
	});
});

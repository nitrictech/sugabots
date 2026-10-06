import { jsonSchema, tool } from "ai";
import { Effect, ManagedRuntime, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BlobStore } from "../../../blob-store/blob-store.ts";
import { effectRunner } from "../../../database/database.ts";
import { noDatabase } from "../../../database/testing.ts";
import { UserMessage } from "../../../user-message.ts";
import { ThreadFiles } from "../../thread-files/thread-files.ts";
import { ToolExecutionRefused } from "../approvals/approved-calls.ts";
import { type LongResult, MAX_RESULT_CHARACTERS } from "./large-results.ts";
import { recorded, refused } from "./recorded.ts";
import type { ToolCallRepository } from "./repository.ts";

/**
 * The wrapper against a fake repository: what it writes before and after the tool
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

/** For the cases whose results are short enough that nothing is kept as a file. */
const noFiles: Pick<ThreadFiles.Interface, "write"> = {
	write: () => Effect.die(new Error("No result here is long enough to keep as a file")),
};

function fakeCalls(): Pick<ToolCallRepository.Interface, "open" | "close"> {
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

describe("a refused tool", () => {
	it("refuses every call, recording why without running it", async () => {
		const calls = fakeCalls();
		const execute = vi.fn(async () => "ran");
		const refusal = UserMessage.of`This tool is turned off for bots in this pod.`;
		const off = refused("wiki__wipe", tool({ inputSchema: jsonSchema({}), execute }), refusal, {
			calls,
			run,
			from,
			replyLength: () => 3,
			noteToolCall: () => Effect.void,
		});

		const output = await off.execute?.({}, callOptions);

		expect(output).toEqual({ status: "failed", error: refusal });
		expect(execute).not.toHaveBeenCalled();
		expect(calls.close).toHaveBeenCalledWith(callId, { error: refusal });
	});
});

describe("a recorded tool", () => {
	it("opens the call with its input where the reply stands, then closes it with the output", async () => {
		const calls = fakeCalls();
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
				files: noFiles,
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
		const calls = fakeCalls();
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
				files: noFiles,
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
		const calls = fakeCalls();
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
			{ calls, files: noFiles, run, from, replyLength: () => 0, noteToolCall: () => Effect.void },
		);

		const output = await probe.execute?.({}, callOptions);

		// What was thrown goes to the logs, not to people or the model.
		expect(output).toEqual({ status: "failed", error: "The tool failed before it finished." });
		expect(calls.close).toHaveBeenCalledWith(callId, {
			error: "The tool failed before it finished.",
		});
	});

	it("does not run an approved call its approval no longer covers, nor tell the model why", async () => {
		const calls = fakeCalls();
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
				files: noFiles,
				run,
				from,
				replyLength: () => 0,
				noteToolCall: () => Effect.void,
				approval: {
					approvals: {
						beginExecution: () =>
							Effect.fail(
								new ToolExecutionRefused({
									message: "Connection configuration changed after approval",
								}),
							),
					},
					binding: {
						kind: "connection",
						connectionId: "0199a3a0-0000-7000-8000-000000000021",
						connectionRevision: 1,
						remoteToolName: "probe",
					},
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

describe("a recorded tool with a long result", () => {
	const fileId = "0199a3a0-0000-7000-8000-0000000000f1";

	/** Runs `probe` returning `output`, keeping any file it writes up to `maxSize` bytes. */
	async function callReturning(output: unknown, maxSize = Number.POSITIVE_INFINITY) {
		const written: Array<{ text: string; contentType: string; toolCallId?: string }> = [];
		const result = await callWith(output, {
			write: ({ toolCallId, content }) =>
				Effect.gen(function* () {
					const text = yield* Stream.mkString(Stream.decodeText(content.stream));
					const size = new TextEncoder().encode(text).byteLength;
					if (size > maxSize) return yield* new ThreadFiles.FileTooLarge({ maxSize });
					written.push({ text, contentType: content.contentType, toolCallId });
					return { id: fileId, contentType: content.contentType, size };
				}),
		});
		return { ...result, written };
	}

	/** Runs `probe` returning `output`, with its files written to `files`. */
	async function callWith(output: unknown, files: Pick<ThreadFiles.Interface, "write">) {
		const calls = fakeCalls();
		const probe = recorded(
			"probe",
			tool({ inputSchema: jsonSchema({}), execute: async () => output }),
			{ calls, files, run, from, replyLength: () => 0, noteToolCall: () => Effect.void },
		);
		const given = (await probe.execute?.({}, callOptions)) as LongResult;
		return { given, calls };
	}

	it("keeps the whole result on the call, and gives the model its start and a file to read on", async () => {
		const rows = Array.from({ length: 2_000 }, (_, index) => ({ id: index, name: `row ${index}` }));

		const { given, written, calls } = await callReturning({ rows });

		expect(calls.close).toHaveBeenCalledWith(callId, { output: { rows } });
		expect(written).toEqual([
			{
				text: JSON.stringify({ rows }, null, 2),
				contentType: "application/json",
				toolCallId: callId,
			},
		]);
		expect(given).toMatchObject({
			truncated: true,
			file: fileId,
			characters: JSON.stringify({ rows }).length,
			lines: JSON.stringify({ rows }, null, 2).split("\n").length,
		});
		expect(written[0]?.text.startsWith(given.preview)).toBe(true);
		expect(given.preview.length).toBeLessThan(MAX_RESULT_CHARACTERS);
		expect(given.note).toContain("read_thread_file");
	});

	it("keeps a connection's text, with JSON sent on one line pretty-printed so it has lines to read", async () => {
		const rows = Array.from({ length: 10_000 }, (_, index) => ({ id: index }));
		const result = { content: [{ type: "text", text: JSON.stringify(rows) }] };

		const { written } = await callReturning(result);

		expect(written[0]).toMatchObject({
			text: JSON.stringify(rows, null, 2),
			contentType: "application/json",
		});
	});

	it("keeps the lines of a result that fit in a file when the whole result does not", async () => {
		const output = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n");

		const { given, written } = await callReturning(output, 1_000);

		const kept = written[0]?.text ?? "";
		expect(written).toHaveLength(1);
		expect(output.startsWith(`${kept}\n`)).toBe(true);
		expect(new TextEncoder().encode(kept).byteLength).toBeLessThanOrEqual(1_000);
		expect(given).toMatchObject({ file: fileId, lines: kept.split("\n").length });
		expect(given.note).toContain("the rest was too large to keep");
	});

	it("gives only the result's start, saying so, while the blob store can't be reached", async () => {
		const output = "x".repeat(MAX_RESULT_CHARACTERS * 2);

		const { given, calls } = await callWith(output, {
			write: () =>
				new BlobStore.Unavailable({ operation: "put", provider: "postgres", cause: "offline" }),
		});

		expect(calls.close).toHaveBeenCalledWith(callId, { output });
		expect(given).not.toHaveProperty("file");
		expect(output.startsWith(given.preview)).toBe(true);
		expect(given.note).toContain("could not be kept");
	});

	it("gives only the result's start when the blob store rejects keeping it", async () => {
		const output = "x".repeat(MAX_RESULT_CHARACTERS * 2);

		const { given } = await callWith(output, {
			write: () =>
				new BlobStore.Rejected({ operation: "put", provider: "postgres", cause: "denied" }),
		});

		expect(given).not.toHaveProperty("file");
		expect(output.startsWith(given.preview)).toBe(true);
	});

	it("keeps the output on the call but tells the model it failed when keeping the file dies", async () => {
		const output = "x".repeat(MAX_RESULT_CHARACTERS * 2);

		const { given, calls } = await callWith(output, {
			write: () => Effect.die(new Error("database gone")),
		});

		expect(calls.close).toHaveBeenCalledWith(callId, { output });
		expect(given).toMatchObject({ status: "failed" });
	});

	it("counts a final newline as ending the last line, as read_thread_file does", async () => {
		const output = "line\n".repeat(20_000);

		const { given } = await callReturning(output);

		expect(given).toMatchObject({ lines: 20_000 });
	});

	it("keeps a result within the size limit when the limit falls inside a character", async () => {
		const output = "é".repeat(MAX_RESULT_CHARACTERS);

		const { given, written } = await callReturning(output, 1_001);

		expect(written[0]?.text).toBe("é".repeat(500));
		expect(given).toMatchObject({ file: fileId });
	});

	it("gives a result's images whole, and keeps only the rest when it is long", async () => {
		const images = [{ data: "A".repeat(MAX_RESULT_CHARACTERS * 2), mediaType: "image/png" }];
		const short = await callReturning({ text: "a screenshot", images });
		const text = "x".repeat(MAX_RESULT_CHARACTERS * 2);

		const long = await callReturning({ text, images });

		expect(short.given).toEqual({ text: "a screenshot", images });
		expect(short.written).toEqual([]);
		expect(long.given).toMatchObject({ truncated: true, file: fileId, images });
		expect(long.written[0]?.text).toBe(JSON.stringify({ text }, null, 2));
	});

	it("gives a result at the limit whole", async () => {
		const output = "x".repeat(MAX_RESULT_CHARACTERS - 2);

		const { given, written } = await callReturning(output);

		expect(given).toBe(output);
		expect(written).toEqual([]);
	});
});

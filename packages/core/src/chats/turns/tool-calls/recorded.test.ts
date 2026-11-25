import type { CallRecord } from "@sugabots/contracts/turns";
import { userText } from "@sugabots/errors";
import { jsonSchema, tool } from "ai";
import { Effect, Logger, ManagedRuntime, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BlobStore } from "../../../blob-store/blob-store.ts";
import { effectRunner } from "../../../database/database.ts";
import { noDatabase } from "../../../database/testing.ts";
import { ChatFileStore } from "../../../files/chat-file-store.ts";
import { recordedCallOf } from "../../tools/recorded-call.ts";
import type { ToolCallRecorder } from "../tools.ts";
import { type LongResult, MAX_RESULT_CHARACTERS } from "./long-results.ts";
import { recorded, refused } from "./recorded.ts";

/**
 * The wrapper against a fake recorder: what it records before and after the
 * tool runs, and what the model is told when the tool throws or may not run.
 */

const run = effectRunner(ManagedRuntime.make(noDatabase));
const callId = "0199a3a0-0000-7000-8000-0000000000aa";
const chatId = "0199a3a0-0000-7000-8000-000000000001";
const callOptions = { toolCallId: "sdk-1", messages: [] } as never;

/** For the cases whose results are short enough that nothing is kept as a file. */
const noFiles: Pick<ChatFileStore.Interface, "write"> = {
	write: () => Effect.die(new Error("No result here is long enough to keep as a file")),
};

/** A recorder that records every call as `callId`, and starts every approved one. */
function fakeRecorder(): ToolCallRecorder & {
	readonly open: ReturnType<typeof vi.fn>;
	readonly close: ReturnType<typeof vi.fn>;
	readonly startApproved: ReturnType<typeof vi.fn>;
} {
	return {
		open: vi.fn(() => Effect.succeed<CallRecord>({ _tag: "Send", id: callId })),
		close: vi.fn(() => Effect.void),
		startApproved: vi.fn(() =>
			Effect.succeed<CallRecord | undefined>({ _tag: "Send", id: callId }),
		),
	};
}

describe("a refused tool", () => {
	it("refuses every call, recording why without running it", async () => {
		const recorder = fakeRecorder();
		const execute = vi.fn(async () => "ran");
		const refusal = userText`This tool is turned off for this bot.`;
		const off = refused("wiki__wipe", tool({ inputSchema: jsonSchema({}), execute }), refusal, {
			recorder,
			run,
			files: noFiles,
			chatId,
		});

		const output = await off.execute?.({}, callOptions);

		expect(output).toEqual({ status: "failed", error: refusal });
		expect(execute).not.toHaveBeenCalled();
		expect(recorder.open).toHaveBeenCalledWith({
			toolCallId: "sdk-1",
			tool: "wiki__wipe",
			input: {},
			writeOrDelete: false,
			binding: { kind: "built-in" },
		});
		expect(recorder.close).toHaveBeenCalledWith(callId, { error: refusal });
	});

	it.each<{ record: CallRecord; result: unknown }>([
		{
			record: { _tag: "Finished", id: callId, outcome: { output: { removed: true } } },
			result: { removed: true },
		},
		{
			record: { _tag: "Finished", id: callId, outcome: { error: userText`The call failed.` } },
			result: { status: "failed", error: "The call failed." },
		},
		{
			record: { _tag: "Interrupted", id: callId, error: userText`The call was interrupted.` },
			result: { status: "failed", error: "The call was interrupted." },
		},
	])(
		"returns the recorded outcome of a $record._tag call to a tool that is off",
		async ({ record, result }) => {
			const recorder = fakeRecorder();
			recorder.open.mockReturnValue(Effect.succeed(record));
			const execute = vi.fn(async () => "ran");
			const off = refused(
				"wiki__wipe",
				tool({ inputSchema: jsonSchema({}), execute }),
				userText`This tool is turned off for this bot.`,
				{ recorder, files: noFiles, run, chatId },
			);

			expect(await off.execute?.({}, callOptions)).toEqual(result);
			expect(execute).not.toHaveBeenCalled();
			expect(recorder.close).not.toHaveBeenCalled();
		},
	);
});

describe("a recorded tool", () => {
	it("records the call as sent with its input before it runs, then finishes it with the output", async () => {
		const recorder = fakeRecorder();
		const probe = recorded(
			"probe",
			tool({
				inputSchema: Schema.Struct({ q: Schema.String }).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute: async ({ q }) => ({ answer: q.toUpperCase() }),
			}),
			{ recorder, files: noFiles, run, chatId },
		);

		const output = await probe.execute?.({ q: "hi" }, callOptions);

		expect(output).toEqual({ answer: "HI" });
		expect(recorder.open).toHaveBeenCalledWith({
			toolCallId: "sdk-1",
			tool: "probe",
			input: { q: "hi" },
			writeOrDelete: false,
			binding: { kind: "built-in" },
		});
		expect(recorder.close).toHaveBeenCalledWith(callId, { output: { answer: "HI" } });
	});

	it("gives the tool the id its call was recorded as, for a destination that takes an idempotency key", async () => {
		const recorder = fakeRecorder();
		const execute = vi.fn(async (_input: object, { context }: { context?: unknown }) =>
			recordedCallOf(context),
		);
		const probe = recorded(
			"wiki__post",
			tool({
				inputSchema: Schema.Struct({}).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute,
			}),
			{ recorder, files: noFiles, run, chatId, writeOrDelete: true },
		);

		expect(await probe.execute?.({}, callOptions)).toBe(callId);
	});

	it("records a call to a tool that changes things as one that may", async () => {
		const recorder = fakeRecorder();
		const probe = recorded(
			"wiki__wipe",
			tool({
				inputSchema: Schema.Struct({}).pipe(
					Schema.toStandardSchemaV1,
					Schema.toStandardJSONSchemaV1,
				),
				execute: async () => "gone",
			}),
			{ recorder, files: noFiles, run, chatId, writeOrDelete: true },
		);

		await probe.execute?.({}, callOptions);

		expect(recorder.open).toHaveBeenCalledWith(expect.objectContaining({ writeOrDelete: true }));
	});

	it("records that a tool threw, but not what it threw", async () => {
		const recorder = fakeRecorder();
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
			{ recorder, files: noFiles, run, chatId },
		);

		const output = await probe.execute?.({}, callOptions);

		// What was thrown goes to the logs, not to members or the model.
		expect(output).toEqual({ status: "failed", error: "The tool failed before it finished." });
		expect(recorder.close).toHaveBeenCalledWith(callId, {
			error: "The tool failed before it finished.",
		});
	});

	it.each([
		{ writeOrDelete: true, error: expect.stringContaining("Check what it did") },
		{ writeOrDelete: false, error: "The tool stopped before it finished." },
	])(
		"records an interruption for a call that throws after its signal is aborted (write/delete: $writeOrDelete)",
		async ({ writeOrDelete, error }) => {
			const recorder = fakeRecorder();
			const controller = new AbortController();
			const failure = new Error("connector disconnected");
			const logged = vi.fn();
			const logger = Logger.layer([Logger.make(({ message }) => logged(message))]);
			const wipe = recorded(
				"wiki__wipe",
				tool({
					inputSchema: jsonSchema({}),
					execute: async (): Promise<{ ok: boolean }> => {
						controller.abort();
						throw failure;
					},
				}),
				{
					recorder,
					files: noFiles,
					run: (effect) => run(effect.pipe(Effect.provide(logger))),
					chatId,
					writeOrDelete,
				},
			);

			const result = await wipe.execute?.(
				{},
				{
					toolCallId: "sdk-1",
					messages: [],
					abortSignal: controller.signal,
					context: undefined,
				},
			);

			expect(result).toEqual({ status: "failed", error });
			expect(recorder.close).toHaveBeenCalledExactlyOnceWith(callId, { error });
			expect(logged).toHaveBeenCalledWith(["Tool wiki__wipe threw", failure]);
		},
	);

	it("keeps the output a read-only call returns as its signal is aborted", async () => {
		const recorder = fakeRecorder();
		const controller = new AbortController();
		const probe = recorded(
			"probe",
			tool({
				inputSchema: jsonSchema({}),
				execute: async () => {
					controller.abort();
					return { answer: "found" };
				},
			}),
			{ recorder, files: noFiles, run, chatId },
		);

		const output = await probe.execute?.(
			{},
			{ toolCallId: "sdk-1", messages: [], abortSignal: controller.signal, context: undefined },
		);

		expect(output).toEqual({ answer: "found" });
		expect(recorder.close).toHaveBeenCalledExactlyOnceWith(callId, { output });
	});

	it("does not run an approved call its approval no longer covers, nor tell the model why", async () => {
		const recorder = fakeRecorder();
		recorder.startApproved.mockReturnValue(Effect.succeed(undefined));
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
				recorder,
				files: noFiles,
				run,
				chatId,
				approval: {
					binding: {
						kind: "connector",
						connectorId: "0199a3a0-0000-7000-8000-000000000021",
						connectorRevision: 1,
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
		expect(recorder.open).not.toHaveBeenCalled();
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
					if (size > maxSize) return yield* new ChatFileStore.FileTooLarge({ maxSize });
					written.push({ text, contentType: content.contentType, toolCallId });
					return { id: fileId, contentType: content.contentType, size };
				}),
		});
		return { ...result, written };
	}

	/** Runs `probe` returning `output`, with its files written to `files`. */
	async function callWith(output: unknown, files: Pick<ChatFileStore.Interface, "write">) {
		const recorder = fakeRecorder();
		const probe = recorded(
			"probe",
			tool({ inputSchema: jsonSchema({}), execute: async () => output }),
			{ recorder, files, run, chatId },
		);
		const given = (await probe.execute?.({}, callOptions)) as LongResult;
		return { given, calls: recorder };
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
			longResult: true,
			file: fileId,
			characters: JSON.stringify({ rows }).length,
			lines: JSON.stringify({ rows }, null, 2).split("\n").length,
		});
		expect(written[0]?.text.startsWith(given.preview)).toBe(true);
		expect(given.preview.length).toBeLessThan(MAX_RESULT_CHARACTERS);
		expect(given.note).toContain("read_chat_file");
	});

	it("keeps a connector's text, with JSON sent on one line pretty-printed so it has lines to read", async () => {
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

	it("counts a final newline as ending the last line, as read_chat_file does", async () => {
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
		expect(long.given).toMatchObject({ longResult: true, file: fileId, images });
		expect(long.written[0]?.text).toBe(JSON.stringify({ text }, null, 2));
	});

	it("gives a result at the limit whole", async () => {
		const output = "x".repeat(MAX_RESULT_CHARACTERS - 2);

		const { given, written } = await callReturning(output);

		expect(given).toBe(output);
		expect(written).toEqual([]);
	});
});

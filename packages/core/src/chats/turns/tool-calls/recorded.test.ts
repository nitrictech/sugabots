import { READ_CHAT_FILE_TOOL } from "@sugabots/contracts/operations/chat-reads";
import { userText } from "@sugabots/errors";
import { jsonSchema, tool } from "ai";
import { Effect, Logger, ManagedRuntime, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BlobStore } from "../../../blob-store/blob-store.ts";
import { effectRunner } from "../../../database/database.ts";
import { noDatabase } from "../../../database/testing.ts";
import { ChatFileStore } from "../../../files/chat-file-store.ts";
import { recordedCallOf } from "../../tools/recorded-call.ts";
import type { CallRecord } from "../loop-values.ts";
import type { ToolCallRecorder } from "../tools.ts";
import { APPROVAL_NO_LONGER_APPLIES, INTERRUPTED_CALL } from "./lifecycle.ts";
import { type LongResult, MAX_RESULT_CHARACTERS } from "./long-results.ts";
import { READ_INTERRUPTED, RESULT_NOT_GIVEN, recorded, refused, TOOL_THREW } from "./recorded.ts";

const run = effectRunner(ManagedRuntime.make(noDatabase));
const failedCall = userText`The call failed.`;
const interruptedCall = userText`The call was interrupted.`;
const callId = "0199a3a0-0000-7000-8000-0000000000aa";
const chatId = "0199a3a0-0000-7000-8000-000000000001";
const callOptions = { toolCallId: "sdk-1", messages: [] } as never;

/** For the cases whose results are short enough that nothing is kept as a file. */
const noFiles: Pick<ChatFileStore.Interface, "write"> = {
	write: () => Effect.die(new Error("No result here is long enough to keep as a file")),
};

function recorderFor(record: CallRecord = { _tag: "Send", id: callId }): ToolCallRecorder {
	return {
		open: () => Effect.succeed(record),
		close: () => Effect.void,
		startApproved: () => Effect.succeed(record),
	};
}

describe("a refused tool", () => {
	it("gives the model the refusal without running the tool", async () => {
		const recorder = recorderFor();
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
	});

	it.each<{ record: CallRecord; result: unknown }>([
		{
			record: { _tag: "Finished", id: callId, outcome: { output: { removed: true } } },
			result: { removed: true },
		},
		{
			record: { _tag: "Finished", id: callId, outcome: { error: failedCall } },
			result: { status: "failed", error: failedCall },
		},
		{
			record: { _tag: "Interrupted", id: callId, error: interruptedCall },
			result: { status: "failed", error: interruptedCall },
		},
	])(
		"returns the recorded outcome of a $record._tag call to a tool that is off",
		async ({ record, result }) => {
			const recorder = recorderFor(record);
			const execute = vi.fn(async () => "ran");
			const off = refused(
				"wiki__wipe",
				tool({ inputSchema: jsonSchema({}), execute }),
				userText`This tool is turned off for this bot.`,
				{ recorder, files: noFiles, run, chatId },
			);

			expect(await off.execute?.({}, callOptions)).toEqual(result);
			expect(execute).not.toHaveBeenCalled();
		},
	);
});

describe("a recorded tool", () => {
	it("returns the tool output to the model", async () => {
		const recorder = recorderFor();
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
	});

	it("gives the tool the id its call was recorded as, for a destination that takes an idempotency key", async () => {
		const recorder = recorderFor();
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

	it("gives the model a user message when a tool throws", async () => {
		const recorder = recorderFor();
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
		expect(output).toEqual({ status: "failed", error: TOOL_THREW });
	});

	it.each([
		{ writeOrDelete: true, error: INTERRUPTED_CALL },
		{ writeOrDelete: false, error: READ_INTERRUPTED },
	])(
		"returns an interruption for a call that throws after its signal is aborted (write/delete: $writeOrDelete)",
		async ({ writeOrDelete, error }) => {
			const recorder = recorderFor();
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
			expect(logged).toHaveBeenCalledWith(["Tool wiki__wipe threw", failure]);
		},
	);

	it("keeps the output a read-only call returns as its signal is aborted", async () => {
		const recorder = recorderFor();
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
	});

	it("does not run an approved call its approval no longer covers, and tells the model only that its approval no longer applies", async () => {
		const recorder = { ...recorderFor(), startApproved: () => Effect.undefined };
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
			error: APPROVAL_NO_LONGER_APPLIES,
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
					if (size > maxSize) return yield* new ChatFileStore.FileTooLarge({ maxSize });
					written.push({ text, contentType: content.contentType, toolCallId });
					return { id: fileId, contentType: content.contentType, size };
				}),
		});
		return { ...result, written };
	}

	/** Runs `probe` returning `output`, with its files written to `files`. */
	async function callWith(output: unknown, files: Pick<ChatFileStore.Interface, "write">) {
		const recorder = recorderFor();
		const probe = recorded(
			"probe",
			tool({ inputSchema: jsonSchema({}), execute: async () => output }),
			{ recorder, files, run, chatId },
		);
		const given = (await probe.execute?.({}, callOptions)) as LongResult;
		return { given };
	}

	it("gives the model the start of a long result and a file to read on", async () => {
		const rows = Array.from({ length: 2_000 }, (_, index) => ({ id: index, name: `row ${index}` }));

		const { given, written } = await callReturning({ rows });

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
		expect(given.note).toContain(READ_CHAT_FILE_TOOL);
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

		const { given } = await callWith(output, {
			write: () =>
				new BlobStore.Unavailable({ operation: "put", provider: "postgres", cause: "offline" }),
		});

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

	it("gives the model an error when keeping the result dies", async () => {
		const output = "x".repeat(MAX_RESULT_CHARACTERS * 2);

		const { given } = await callWith(output, {
			write: () => Effect.die(new Error("database gone")),
		});

		expect(given).toEqual({ status: "failed", error: RESULT_NOT_GIVEN });
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

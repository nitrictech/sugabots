import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { BlobStore } from "../../../blob-store/blob-store.ts";
import { ThreadFiles } from "../../thread-files/thread-files.ts";
import { MAX_READ_CHARACTERS, type ReadThreadFileResult, readThreadFileTool } from "./tool.ts";

const THREAD = "0199a3a0-0000-7000-8000-000000000001";
const FILE = "0199a3a0-0000-7000-8000-0000000000f1";

/** `read_thread_file` over one file in `THREAD`, called with `input`. */
async function read(
	text: string,
	input: { file?: string; offset?: number; limit?: number; pattern?: string },
	contentType = "text/plain; charset=utf-8",
): Promise<ReadThreadFileResult> {
	return readFrom(
		{
			read: ({ threadId, fileId }) =>
				threadId === THREAD && fileId === FILE
					? Effect.succeed({
							id: FILE,
							contentType,
							size: text.length,
							stream: Stream.succeed(new TextEncoder().encode(text)),
						})
					: new ThreadFiles.FileNotFound({ fileId }),
		},
		input,
	);
}

async function readFrom(
	files: Pick<ThreadFiles.Interface, "read">,
	input: { file?: string; offset?: number; limit?: number; pattern?: string },
): Promise<ReadThreadFileResult> {
	const tool = readThreadFileTool({ threadId: THREAD, files, run: Effect.runPromise });
	const options = { toolCallId: "call", messages: [] } as unknown as Parameters<
		NonNullable<typeof tool.execute>
	>[1];
	return tool.execute?.({ file: FILE, ...input }, options) as Promise<ReadThreadFileResult>;
}

const numbered = (count: number) =>
	Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("read_thread_file", () => {
	it("reads numbered lines from an offset, and says where to continue", async () => {
		expect(await read(numbered(10), { offset: 3, limit: 2 })).toEqual({
			lines: "3\tline 3\n4\tline 4",
			totalLines: 10,
			continueFrom: 5,
		});
	});

	it("says nothing about continuing once it reaches the end", async () => {
		expect(await read("one\r\ntwo\n", {})).toEqual({ lines: "1\tone\n2\ttwo", totalLines: 2 });
	});

	it("returns only lines containing the pattern, ignoring case", async () => {
		expect(await read("alpha\nBeta\ngamma\nbetamax", { pattern: "BETA" })).toEqual({
			lines: "2\tBeta\n4\tbetamax",
			totalLines: 4,
		});
	});

	it("stops short of the character limit as JSON escapes it, at a line it can continue from", async () => {
		const line = '"\\\u001b'.repeat(250);
		const text = Array.from({ length: 100 }, () => line).join("\n");

		const result = await read(text, {});

		if (!("lines" in result)) throw new Error("refused");
		expect(JSON.stringify(result.lines).length).toBeLessThanOrEqual(MAX_READ_CHARACTERS);
		expect(result.continueFrom).toBe(result.lines.split("\n").length + 1);
	});

	it("refuses a file from another thread, an offset past the end, and a file that isn't text", async () => {
		expect(await read("text", { file: "0199a3a0-0000-7000-8000-0000000000f2" })).toHaveProperty(
			"refused",
		);
		expect(await read(numbered(3), { offset: 4 })).toEqual({
			refused: "The file has 3 lines, so there is no line 4.",
		});
		expect(await read("PNG", {}, "image/png")).toHaveProperty("refused");
	});

	it("refuses, so the model can try again, while the blob store can't be reached", async () => {
		const unreachable: Pick<ThreadFiles.Interface, "read"> = {
			read: () =>
				new BlobStore.Unavailable({ operation: "get", provider: "postgres", cause: "offline" }),
		};

		expect(await readFrom(unreachable, {})).toEqual({
			refused: "The file can't be read right now. Try again shortly.",
		});
	});

	it("refuses without suggesting another try when the blob store rejects reading", async () => {
		const rejecting: Pick<ThreadFiles.Interface, "read"> = {
			read: () =>
				new BlobStore.Rejected({ operation: "get", provider: "postgres", cause: "denied" }),
		};

		expect(await readFrom(rejecting, {})).toEqual({
			refused: "Files can't be read in this installation.",
		});
	});
});

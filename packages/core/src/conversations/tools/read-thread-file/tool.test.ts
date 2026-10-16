import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { BlobStore } from "../../../blob-store/blob-store.ts";
import { ThreadFiles } from "../../thread-files/thread-files.ts";
import { MAX_IMAGE_BYTES } from "../images.ts";
import { MAX_READ_CHARACTERS, type ReadThreadFileResult, readThreadFileTool } from "./tool.ts";

const THREAD = "0199a3a0-0000-7000-8000-000000000001";
const FILE = "0199a3a0-0000-7000-8000-0000000000f1";

/** The first bytes of every PNG file. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file in `THREAD`: its content, and the name and type it was kept with. */
interface Kept {
	content: string | Uint8Array;
	name?: string;
	contentType?: string;
}

/** The thread files `read_thread_file` reads `kept` through. */
function holding({
	content,
	name = "notes.txt",
	contentType = "text/plain; charset=utf-8",
}: Kept): Pick<ThreadFiles.Interface, "read"> {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	return {
		read: ({ threadId, fileId }) =>
			threadId === THREAD && fileId === FILE
				? Effect.succeed({
						id: FILE,
						name,
						contentType,
						size: bytes.byteLength,
						stream: Stream.succeed(bytes),
					})
				: new ThreadFiles.FileNotFound({ fileId }),
	};
}

function toolOver(files: Pick<ThreadFiles.Interface, "read">, acceptsImages: boolean) {
	return readThreadFileTool({ threadId: THREAD, files, acceptsImages, run: Effect.runPromise });
}

async function readFrom(
	files: Pick<ThreadFiles.Interface, "read">,
	input: { file?: string; offset?: number; limit?: number; pattern?: string },
	acceptsImages = false,
): Promise<ReadThreadFileResult> {
	const tool = toolOver(files, acceptsImages);
	const options = { toolCallId: "call", messages: [] } as unknown as Parameters<
		NonNullable<typeof tool.execute>
	>[1];
	return tool.execute?.({ file: FILE, ...input }, options) as Promise<ReadThreadFileResult>;
}

/** `read_thread_file` over one text file holding `text`, called with `input`. */
const read = (
	text: string,
	input: { file?: string; offset?: number; limit?: number; pattern?: string },
) => readFrom(holding({ content: text }), input);

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

	it("refuses a file from another thread, and an offset past the end", async () => {
		expect(await read("text", { file: "0199a3a0-0000-7000-8000-0000000000f2" })).toHaveProperty(
			"refused",
		);
		expect(await read(numbered(3), { offset: 4 })).toEqual({
			refused: "The file has 3 lines, so there is no line 4.",
		});
	});

	it("reads text whatever type it was given, and text it was told is text in any encoding", async () => {
		// A TypeScript file, which extension lookup calls an MPEG video.
		const source = holding({
			content: "const a = 1;\n",
			name: "main.ts",
			contentType: "video/mp2t",
		});
		expect(await readFrom(source, {})).toEqual({ lines: "1\tconst a = 1;", totalLines: 1 });
		// A CSV saved by Excel in Windows-1252: "café", with é as the byte E9.
		const csv = holding({
			content: new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
			name: "menu.csv",
			contentType: "text/csv",
		});
		expect(await readFrom(csv, {})).toEqual({ lines: "1\tcaf�", totalLines: 1 });
	});

	it("refuses a file that is neither text nor an image", async () => {
		const zip = holding({
			content: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
			name: "archive.zip",
			contentType: "application/zip",
		});
		const notUtf8 = holding({
			content: new Uint8Array([0xc3, 0x28]),
			name: "data.bin",
			contentType: "application/octet-stream",
		});

		expect(await readFrom(zip, {})).toEqual({
			refused: "The file is application/zip, not text, so it has no lines to read.",
		});
		expect(await readFrom(notUtf8, {})).toHaveProperty("refused");
	});

	it("shows an image as the type its bytes are, whatever type it was given", async () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
		const png = new Uint8Array(PNG);
		const shown = (content: Uint8Array, contentType: string) =>
			readFrom(holding({ content, name: "chart.png", contentType }), {}, true);

		expect(await shown(jpeg, "image/png")).toEqual({
			text: "The image chart.png.",
			images: [{ data: Buffer.from(jpeg).toString("base64"), mediaType: "image/jpeg" }],
		});
		expect(await shown(png, "application/octet-stream")).toMatchObject({
			images: [{ mediaType: "image/png" }],
		});
	});

	it("refuses an image to a model that can't see one, or one too large to show", async () => {
		const large = new Uint8Array(MAX_IMAGE_BYTES + 1);
		large.set(PNG);

		expect(
			await readFrom(
				holding({ content: new Uint8Array(PNG), contentType: "image/png" }),
				{},
				false,
			),
		).toEqual({ refused: "The file is an image, and you can't be shown images." });
		expect(await readFrom(holding({ content: large, contentType: "image/png" }), {}, true)).toEqual(
			{
				refused: `The image is ${MAX_IMAGE_BYTES + 1} bytes, larger than the ${MAX_IMAGE_BYTES} that can be shown.`,
			},
		);
	});

	it("gives a model that can see images the image itself", () => {
		const tool = toolOver(
			holding({ content: new Uint8Array(PNG), contentType: "image/png" }),
			true,
		);
		const output = {
			text: "The image chart.png.",
			images: [{ data: "iVBORw0KGgo=", mediaType: "image/png" }],
		};

		expect(tool.toModelOutput?.({ toolCallId: "call", input: { file: FILE }, output })).toEqual({
			type: "content",
			value: [
				{ type: "text", text: "The image chart.png." },
				{
					type: "file",
					data: { type: "data", data: "iVBORw0KGgo=" },
					mediaType: "image/png",
				},
			],
		});
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

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createEgressHttpClients } from "../../../providers/network/egress.ts";
import { ThreadFiles } from "../../thread-files/thread-files.ts";
import { signedUploadTool } from "./tool.ts";

const THREAD = "0199a3a0-0000-7000-8000-000000000001";
const FILE = "0199a3a0-0000-7000-8000-0000000000f1";
const SCREENSHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const SERVICE = {
	destination: "https://storage.googleapis.com/uploads.example.com/",
	howTo: "Get the URL from prepare_upload.",
};
const SIGNED_URL = `${SERVICE.destination}org/file?X-Goog-Signature=abc`;
/** As a signing service gives them, casing included. */
const SIGNED_HEADERS = {
	"content-type": "image/png",
	"x-goog-content-length-range": "10,10",
	"Content-Disposition": 'attachment; filename="bug.png"',
};

const files: Pick<ThreadFiles.Interface, "read"> = {
	read: ({ threadId, fileId }) =>
		threadId === THREAD && fileId === FILE
			? Effect.succeed({
					id: FILE,
					name: "bug.png",
					contentType: "image/png",
					size: SCREENSHOT.byteLength,
					stream: Stream.succeed(SCREENSHOT),
				})
			: new ThreadFiles.FileNotFound({ fileId }),
};

interface Sent {
	url: string;
	method: string | undefined;
	headers: Headers;
	body: Uint8Array;
}

/** The upload tool without a sandbox, over the real egress policy with the network answering `status`. */
function uploadWith(status = 200, answer = "") {
	const sent: Sent[] = [];
	const upload = createEgressHttpClients({
		lookup: async () => [{ address: "142.250.70.16", family: 4 }],
		fetch: async (input, init) => {
			sent.push({
				url: String(input),
				method: init.method,
				headers: new Headers(init.headers),
				body: new Uint8Array(init.body as Uint8Array),
			});
			return new Response(answer, { status });
		},
	});
	const tool = signedUploadTool(SERVICE, {
		threadId: THREAD,
		files,
		sandbox: undefined,
		upload,
		run: Effect.runPromise,
	});
	const call = (input: {
		file?: string;
		path?: string;
		uploadUrl: string;
		headers: Record<string, string>;
	}) => tool.execute?.(input, { toolCallId: "call", messages: [] } as never);
	return { call, sent };
}

describe("a signed upload tool", () => {
	it("PUTs a thread file's bytes to the signed URL with the signed headers as given", async () => {
		const { call, sent } = uploadWith();

		const result = await call({ file: FILE, uploadUrl: SIGNED_URL, headers: SIGNED_HEADERS });

		expect(result).toEqual({ status: "uploaded", bytes: SCREENSHOT.byteLength });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(SIGNED_URL);
		expect(sent[0]?.method).toBe("PUT");
		expect(sent[0]?.body).toEqual(SCREENSHOT);
		expect(sent[0]?.headers.get("x-goog-content-length-range")).toBe("10,10");
		expect(sent[0]?.headers.get("content-disposition")).toBe('attachment; filename="bug.png"');
	});

	it.each([
		["another host", "https://attacker.example/upload"],
		["another bucket", "https://storage.googleapis.com/someone-elses-bucket/file"],
		["a path that climbs out of the service's bucket", `${SERVICE.destination}../other/file`],
		["plain HTTP", SIGNED_URL.replace("https:", "http:")],
	])("refuses %s without sending anything", async (_, uploadUrl) => {
		const { call, sent } = uploadWith();

		const result = await call({ file: FILE, uploadUrl, headers: SIGNED_HEADERS });

		expect(result).toMatchObject({ status: "failed" });
		expect(sent).toEqual([]);
	});

	it("refuses a sandbox path when the turn has no sandbox", async () => {
		const { call, sent } = uploadWith();

		const result = await call({ path: "shots/bug.png", uploadUrl: SIGNED_URL, headers: {} });

		expect(result).toEqual({
			status: "failed",
			error: "This bot has no sandbox, so only files in the thread can be uploaded.",
		});
		expect(sent).toEqual([]);
	});

	it("says what the service answered when it refuses the upload", async () => {
		const { call } = uploadWith(400, "<Error><Code>ExpiredToken</Code></Error>");

		const result = await call({ file: FILE, uploadUrl: SIGNED_URL, headers: SIGNED_HEADERS });

		expect(result).toEqual({
			status: "failed",
			error: "The upload was refused with HTTP 400: <Error><Code>ExpiredToken</Code></Error>",
		});
	});

	it("says when the thread has no such file", async () => {
		const { call, sent } = uploadWith();

		const result = await call({
			file: "0199a3a0-0000-7000-8000-0000000000f2",
			uploadUrl: SIGNED_URL,
			headers: SIGNED_HEADERS,
		});

		expect(result).toEqual({
			status: "failed",
			error: "There is no file with that id in this thread.",
		});
		expect(sent).toEqual([]);
	});
});

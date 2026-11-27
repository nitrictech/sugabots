import { Effect, Logger, Stream } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";
import { ChatFileStore } from "../../../files/chat-file-store.ts";
import { createEgressHttpClients } from "../../../providers/network/egress.ts";
import { SignedUploadRefused, signedUploadTool } from "./tool.ts";

const CHAT = "0199a3a0-0000-7000-8000-000000000001";
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

const files: Pick<ChatFileStore.Interface, "read"> = {
	read: ({ chatId, fileId }) =>
		chatId === CHAT && fileId === FILE
			? Effect.succeed({
					id: FILE,
					name: "bug.png",
					contentType: "image/png",
					size: SCREENSHOT.byteLength,
					stream: Stream.succeed(SCREENSHOT),
				})
			: new ChatFileStore.FileNotFound({ fileId }),
};

interface Sent {
	url: string;
	method: string | undefined;
	headers: Headers;
	body: Uint8Array;
}

/** The upload tool without a computer, over the real egress policy with the network answering `status`. */
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
	onTestFinished(() => upload.close());
	const logged: unknown[] = [];
	const logger = Logger.layer([Logger.make(({ message }) => logged.push(message))]);
	const tool = signedUploadTool(SERVICE, {
		chatId: CHAT,
		files,
		computer: undefined,
		upload,
		run: (effect) => Effect.runPromise(effect.pipe(Effect.provide(logger))),
	});
	const call = (input: {
		file?: string;
		path?: string;
		uploadUrl: string;
		headers: Record<string, string>;
	}) => tool.execute?.(input, { toolCallId: "call", messages: [] } as never);
	return { call, sent, logged };
}

describe("a signed upload tool", () => {
	it("PUTs a chat file's bytes to the signed URL with the signed headers as given", async () => {
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

	it("refuses a computer path when the turn has no computer", async () => {
		const { call, sent } = uploadWith();

		const result = await call({ path: "shots/bug.png", uploadUrl: SIGNED_URL, headers: {} });

		expect(result).toEqual({
			status: "failed",
			error: "This bot has no computer, so only files in the chat can be uploaded.",
		});
		expect(sent).toEqual([]);
	});

	it("gives the bot the HTTP status and keeps the upload service's body in the log", async () => {
		const httpStatus = 400;
		const upstreamMessage = "<Error><Code>ExpiredToken</Code></Error>";
		const { call, logged } = uploadWith(httpStatus, upstreamMessage);

		const result = await call({ file: FILE, uploadUrl: SIGNED_URL, headers: SIGNED_HEADERS });

		expect(result).toEqual({
			status: "failed",
			error: new SignedUploadRefused({ httpStatus, upstreamMessage: "" }).userMessage,
		});
		expect(result).toMatchObject({ error: expect.stringContaining(String(httpStatus)) });
		expect(logged).toContainEqual([expect.stringContaining(upstreamMessage)]);
	});

	it("says when the chat has no such file", async () => {
		const { call, sent } = uploadWith();

		const result = await call({
			file: "0199a3a0-0000-7000-8000-0000000000f2",
			uploadUrl: SIGNED_URL,
			headers: SIGNED_HEADERS,
		});

		expect(result).toEqual({
			status: "failed",
			error: "There is no file with that id in this chat.",
		});
		expect(sent).toEqual([]);
	});
});

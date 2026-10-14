import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { BadRequest } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { act, cleanup, renderHook } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendReadiness, useComposerAttachments } from "@/lib/composer-attachments.ts";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const chatId = "0199a3a0-0000-7000-8000-0000000000e1";
const fileId = "0199a3a0-0000-7000-8000-0000000000f1";

/**
 * Stands in for the browser's XMLHttpRequest, the boundary uploads cross, so
 * a test says how far each upload has got and what the API answers.
 */
class FakeRequest {
	static made: FakeRequest[] = [];
	method = "";
	url = "";
	withCredentials = false;
	responseType = "";
	status = 0;
	response: unknown = null;
	body: unknown;
	aborted = false;
	private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
	private readonly uploadListeners = new Map<string, ((event: unknown) => void)[]>();
	upload = {
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			this.uploadListeners.set(type, [...(this.uploadListeners.get(type) ?? []), listener]);
		},
	};

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}

	addEventListener(type: string, listener: () => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	send(body: unknown) {
		this.body = body;
		FakeRequest.made.push(this);
	}

	abort() {
		this.aborted = true;
		this.emit("abort");
	}

	progress(loaded: number, total: number) {
		for (const listener of this.uploadListeners.get("progress") ?? []) {
			listener({ lengthComputable: true, loaded, total });
		}
	}

	/** The connection drops before the API answers. */
	fail() {
		this.emit("error");
	}

	answer(status: number, response: unknown) {
		this.status = status;
		this.response = response;
		this.emit("load");
	}

	private emit(type: string) {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
}

function pdf(name = "report.pdf"): File {
	return new File(["%PDF"], name, { type: "application/pdf" });
}

function uploadedAs(file: File, id = fileId) {
	return { id, name: file.name, contentType: file.type, size: file.size };
}

/** Attaches `file` and lets the API accept it as `id`. */
async function attachUploaded(
	attachments: { current: ReturnType<typeof useComposerAttachments> },
	file: File,
	id = fileId,
) {
	act(() => attachments.current.attach?.([file]));
	act(() => FakeRequest.made.at(-1)?.answer(201, uploadedAs(file, id)));
	await settle();
}

/** Lets the promise callbacks an answer settles run. */
async function settle() {
	await act(async () => {});
}

beforeEach(() => {
	FakeRequest.made = [];
	vi.stubGlobal("XMLHttpRequest", FakeRequest);
	client.api.chats.removeFile.mockReturnValue(Effect.void);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("useComposerAttachments", () => {
	it("uploads a file as soon as it is attached, with its progress, ready to send", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		act(() => result.current.attach?.([file]));

		const [request] = FakeRequest.made;
		expect(request?.method).toBe("POST");
		expect(request?.url).toBe(
			`https://api.test/chats/${chatId}/files?name=report.pdf&type=application%2Fpdf`,
		);
		expect(request?.withCredentials).toBe(true);
		expect(request?.body).toBe(file);
		expect(sendReadiness(result.current.items)).toEqual({ ready: false, failed: 0, uploading: 1 });

		act(() => request?.progress(1, 4));
		expect(result.current.items[0]?.upload).toEqual({ state: "uploading", progress: 0.25 });

		act(() => request?.answer(201, uploadedAs(file)));
		await settle();
		expect(result.current.items[0]?.upload).toEqual({
			state: "uploaded",
			attachment: uploadedAs(file),
		});
		expect(sendReadiness(result.current.items)).toEqual({ ready: true });
	});

	it("leaves the type for the API to work out when the browser has none", () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		act(() => result.current.attach?.([new File(["x"], "notes.weird")]));
		expect(FakeRequest.made[0]?.url).toBe(
			`https://api.test/chats/${chatId}/files?name=notes.weird`,
		);
	});

	it("never uploads a file over the size limit, and it holds the message back", () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const recording = new File(["x"], "call.mp4", { type: "video/mp4" });
		Object.defineProperty(recording, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
		act(() => result.current.attach?.([recording]));

		expect(FakeRequest.made).toHaveLength(0);
		expect(result.current.items[0]?.upload).toEqual({ state: "tooLarge" });
		expect(result.current.takeForSending("")).toBeUndefined();
	});

	it("attaches files up to the limit and counts the rest as left out", () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 3 }, (_, index) =>
			pdf(`invoice-${index}.pdf`),
		);
		act(() => result.current.attach?.(files));

		expect(result.current.items.map((item) => item.file)).toEqual(
			files.slice(0, MAX_ATTACHMENTS_PER_MESSAGE),
		);
		expect(result.current.leftOut).toBe(3);

		act(() => result.current.attach?.([pdf("one-more.pdf")]));
		expect(result.current.items).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
		expect(result.current.leftOut).toBe(1);
	});

	it("stops an upload when its file is removed, and removes the file if it finished anyway", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		act(() => result.current.attach?.([file, pdf("second.pdf")]));
		const [first, second] = FakeRequest.made;

		act(() => result.current.remove(result.current.items[0]?.key ?? ""));
		expect(first?.aborted).toBe(true);
		expect(result.current.items.map((item) => item.file.name)).toEqual(["second.pdf"]);

		// The answer arrives, but the chip goes before it is read.
		act(() => {
			second?.answer(201, uploadedAs(file, "0199a3a0-0000-7000-8000-0000000000f2"));
			result.current.remove(result.current.items[0]?.key ?? "");
		});
		await settle();
		expect(result.current.items).toEqual([]);
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({
			params: { chatId, fileId: "0199a3a0-0000-7000-8000-0000000000f2" },
		});
	});

	it("removes an uploaded file from the API when its chip is removed", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		act(() => result.current.attach?.([file]));
		act(() => FakeRequest.made[0]?.answer(201, uploadedAs(file)));
		await settle();

		act(() => result.current.remove(result.current.items[0]?.key ?? ""));
		expect(result.current.items).toEqual([]);
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({ params: { chatId, fileId } });
	});

	it("keeps a refused upload on its chip with the API's reason, and retries it there", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		act(() => result.current.attach?.([file]));
		const reason = "You can have 20 files waiting to be sent at most. Send or remove some first";
		act(() => FakeRequest.made[0]?.answer(409, { _tag: "Conflict", message: reason }));
		await settle();
		const key = result.current.items[0]?.key;
		expect(result.current.items[0]?.upload).toEqual({
			state: "failed",
			reason: `${reason}.`,
			retryable: true,
		});
		expect(sendReadiness(result.current.items)).toEqual({ ready: false, failed: 1, uploading: 0 });

		act(() => result.current.retry(key ?? ""));
		act(() => FakeRequest.made[1]?.answer(201, uploadedAs(file)));
		await settle();
		expect(result.current.items).toEqual([
			{ key, file, upload: { state: "uploaded", attachment: uploadedAs(file) } },
		]);
	});

	it("takes the uploaded files to send, and puts them back when the message is not sent", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		act(() => result.current.attach?.([file]));
		act(() => FakeRequest.made[0]?.answer(201, uploadedAs(file)));
		await settle();
		const attached = result.current.items;

		let taken: ReturnType<typeof result.current.takeForSending>;
		act(() => {
			taken = result.current.takeForSending("");
		});
		// As the message shows them until the API answers.
		expect(taken?.parts).toEqual([
			{ type: "file", id: fileId, name: file.name, contentType: file.type, size: file.size },
		]);
		expect(result.current.items).toEqual([]);

		act(() => taken?.putBack(new Error("The connection dropped")));
		expect(result.current.items).toEqual(attached);
	});

	it("stops uploads and removes the unsent files when the chat is left", async () => {
		const { result, unmount } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		act(() => result.current.attach?.([file, pdf("second.pdf")]));
		const [uploaded, inFlight] = FakeRequest.made;
		act(() => uploaded?.answer(201, uploadedAs(file)));
		await settle();

		unmount();
		expect(inFlight?.aborted).toBe(true);
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({ params: { chatId, fileId } });
	});

	it("has nothing to attach to until the chat exists", () => {
		const { result } = renderHook(() => useComposerAttachments(undefined));
		expect(result.current.attach).toBeUndefined();
	});

	it("sends text, files or both, but nothing empty and nothing still uploading", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		expect(result.current.takeForSending("   ")).toBeUndefined();
		expect(result.current.takeForSending("Hello")?.parts).toEqual([]);

		const file = pdf();
		act(() => result.current.attach?.([file]));
		expect(result.current.takeForSending("Hello")).toBeUndefined();
		act(() => FakeRequest.made[0]?.answer(201, uploadedAs(file)));
		await settle();
		let taken: ReturnType<typeof result.current.takeForSending>;
		act(() => {
			taken = result.current.takeForSending("");
		});
		expect(taken?.parts).toEqual([{ type: "file", ...uploadedAs(file) }]);
	});

	it.each([
		["the connection drops", (request: FakeRequest) => request.fail()],
		[
			"the API has trouble of its own",
			(request: FakeRequest) =>
				request.answer(500, { _tag: "InternalServerError", message: "Something went wrong" }),
		],
		["a proxy fails in front of the API", (request: FakeRequest) => request.answer(502, "<html>")],
	])("offers to retry an upload when %s", async (_, failUpload) => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		act(() => result.current.attach?.([pdf()]));
		act(() => failUpload(FakeRequest.made[0] as FakeRequest));
		await settle();
		expect(result.current.items[0]?.upload).toMatchObject({ state: "failed", retryable: true });

		act(() => result.current.retry(result.current.items[0]?.key ?? ""));
		expect(FakeRequest.made).toHaveLength(2);
	});

	it.each([
		["refuses its type", 400, { _tag: "BadRequest", message: "That isn't a media type" }],
		["finds it too large", 413, { _tag: "PayloadTooLarge", message: "The file is too large" }],
	])("does not retry an upload the API %s", async (_, status, body) => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		act(() => result.current.attach?.([pdf()]));
		act(() => FakeRequest.made[0]?.answer(status, body));
		await settle();
		expect(result.current.items[0]?.upload).toEqual({
			state: "failed",
			reason: `${body.message}.`,
			retryable: false,
		});

		act(() => result.current.retry(result.current.items[0]?.key ?? ""));
		expect(FakeRequest.made).toHaveLength(1);
	});

	it.each([
		["is over 255 characters", `${"a".repeat(252)}.pdf`],
		["has a control character", "report\u0007.pdf"],
		["is only spaces", "   "],
	])("never uploads a file whose name %s, and cannot retry it", (_, name) => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		act(() => result.current.attach?.([pdf(name)]));

		expect(FakeRequest.made).toHaveLength(0);
		expect(result.current.items[0]?.upload).toMatchObject({ state: "failed", retryable: false });
		act(() => result.current.retry(result.current.items[0]?.key ?? ""));
		expect(FakeRequest.made).toHaveLength(0);
	});

	it("uploads a file whose name is 255 characters", () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		act(() => result.current.attach?.([pdf(`${"a".repeat(251)}.pdf`)]));
		expect(FakeRequest.made).toHaveLength(1);
	});

	it("puts files the API no longer had back as failed, and uploads each again on retry", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		const file = pdf();
		await attachUploaded(result, file);

		let taken: ReturnType<typeof result.current.takeForSending>;
		act(() => {
			taken = result.current.takeForSending("");
		});
		const refusal = new BadRequest({
			message: userText`A file to send is no longer there. Remove it and attach it again`,
			error: {
				_tag: "UploadsNotFound",
				userMessage: userText`A file to send is no longer there. Remove it and attach it again`,
				isRetryable: false,
			},
		});
		act(() => taken?.putBack(refusal));

		const [item] = result.current.items;
		expect(item?.upload).toMatchObject({ state: "failed", retryable: true });
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({ params: { chatId, fileId } });

		const freshId = "0199a3a0-0000-7000-8000-0000000000f3";
		act(() => result.current.retry(item?.key ?? ""));
		act(() => FakeRequest.made[1]?.answer(201, uploadedAs(file, freshId)));
		await settle();
		expect(FakeRequest.made[1]?.body).toBe(file);
		expect(result.current.items[0]?.upload).toEqual({
			state: "uploaded",
			attachment: uploadedAs(file, freshId),
		});
	});

	it("puts files back only once", async () => {
		const { result } = renderHook(() => useComposerAttachments(chatId));
		await attachUploaded(result, pdf());

		let taken: ReturnType<typeof result.current.takeForSending>;
		act(() => {
			taken = result.current.takeForSending("");
		});
		act(() => {
			taken?.putBack(new Error("The connection dropped"));
			taken?.putBack(new Error("The connection dropped"));
		});
		expect(result.current.items).toHaveLength(1);
	});

	it("removes the files of a message that fails after the chat is left", async () => {
		const { result, unmount } = renderHook(() => useComposerAttachments(chatId));
		await attachUploaded(result, pdf());
		let taken: ReturnType<typeof result.current.takeForSending>;
		act(() => {
			taken = result.current.takeForSending("");
		});

		unmount();
		expect(client.api.chats.removeFile).not.toHaveBeenCalled();
		taken?.putBack(new Error("The connection dropped"));
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({ params: { chatId, fileId } });
	});

	it("empties the composer for the next chat, and keeps the last chat's files out of it", async () => {
		const nextChatId = "0199a3a0-0000-7000-8000-0000000000e2";
		const { result, rerender } = renderHook((id: string) => useComposerAttachments(id), {
			initialProps: chatId,
		});
		const sending = pdf("sending.pdf");
		await attachUploaded(result, sending);
		let taken: ReturnType<typeof result.current.takeForSending>;
		act(() => {
			taken = result.current.takeForSending("");
		});
		const waiting = pdf("waiting.pdf");
		const waitingId = "0199a3a0-0000-7000-8000-0000000000f4";
		await attachUploaded(result, waiting, waitingId);
		const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
			pdf(`invoice-${index}.pdf`),
		);
		act(() => result.current.attach?.(files));
		const stillUploading = FakeRequest.made.at(-1);
		expect(result.current.leftOut).toBe(1);

		rerender(nextChatId);
		expect(result.current.items).toEqual([]);
		expect(result.current.leftOut).toBe(0);
		expect(stillUploading?.aborted).toBe(true);
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({
			params: { chatId, fileId: waitingId },
		});

		act(() => taken?.putBack(new Error("The connection dropped")));
		expect(result.current.items).toEqual([]);
		expect(client.api.chats.removeFile).toHaveBeenCalledWith({ params: { chatId, fileId } });
	});
});

import { vi } from "vitest";

/**
 * Stands in for the browser's XMLHttpRequest, the boundary uploads cross, so
 * a test says how far each upload has got and what the API answers.
 */
export class FakeRequest {
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

export function stubAttachmentUploads() {
	FakeRequest.made = [];
	vi.stubGlobal("XMLHttpRequest", FakeRequest);
}

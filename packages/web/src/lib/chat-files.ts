import { type UploadedAttachment, uploadedAttachmentSchema } from "@sugabots/contracts";
import { failureFromResponse } from "@sugabots/sdk";
import { Effect, Schema } from "effect";
import { client } from "@/api.ts";

const decodeUploadedAttachment = Schema.decodeUnknownSync(uploadedAttachmentSchema);

/** An upload that never got an answer from the API: the connection dropped, or it was stopped. */
export class UploadInterrupted extends Error {
	constructor() {
		super("The upload did not finish");
		this.name = "UploadInterrupted";
	}
}

/**
 * Uploads `file` to the chat, ready to attach to a message, reporting how much
 * of it has gone as a fraction from 0 to 1. Sent with XMLHttpRequest, because
 * fetch cannot report an upload's progress. Fails with the API's failure when
 * it refuses the file, or `UploadInterrupted` when there is no answer,
 * including when `signal` aborts it.
 */
export function uploadChatFile({
	chatId,
	file,
	onProgress,
	signal,
}: {
	chatId: string;
	file: File;
	onProgress: (fraction: number) => void;
	signal: AbortSignal;
}): Promise<UploadedAttachment> {
	return new Promise((resolve, reject) => {
		const query = new URLSearchParams({ name: file.name });
		// Left out when the browser has no type for it, so the API takes one from the name.
		if (file.type) query.set("type", file.type);
		const request = new XMLHttpRequest();
		request.open("POST", `${client.baseUrl}/chats/${encodeURIComponent(chatId)}/files?${query}`);
		request.withCredentials = true;
		request.responseType = "json";
		request.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
		});
		request.addEventListener("load", () => {
			if (request.status !== 201) {
				reject(failureFromResponse(request.response, request.status));
				return;
			}
			try {
				resolve(decodeUploadedAttachment(request.response));
			} catch (error) {
				reject(error);
			}
		});
		request.addEventListener("error", () => reject(new UploadInterrupted()));
		request.addEventListener("abort", () => reject(new UploadInterrupted()));
		if (signal.aborted) {
			reject(new UploadInterrupted());
			return;
		}
		signal.addEventListener("abort", () => request.abort(), { once: true });
		request.send(file);
	});
}

/**
 * Removes an upload that will not be sent, so it stops counting toward the
 * files a person can have waiting. Nothing waits on it, and a failure is left
 * alone: the API clears unsent uploads by itself after a day.
 */
export function removeChatFile(chatId: string, fileId: string): void {
	Effect.runPromise(client.api.chats.removeFile({ params: { chatId, fileId } })).catch(() => {});
}

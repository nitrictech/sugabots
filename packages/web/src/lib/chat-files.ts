import { type UploadedAttachment, uploadedAttachmentSchema } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { failureForStatus, failureFromResponse } from "@sugabots/sdk";
import { Effect, Schema } from "effect";
import { client } from "@/api.ts";

const decodeUploadedAttachment = Schema.decodeUnknownSync(uploadedAttachmentSchema);

/** An upload that never got an answer from the API: the connection dropped, or it was stopped. */
// biome-ignore lint/plugin/errors-implement-domain-error: Browser transport signal from XMLHttpRequest.
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
		const url = buildUploadUrl(chatId, file);
		if (url === undefined) {
			reject(
				failureForStatus(
					400,
					userText`This file's name is too long or has characters that can't be uploaded. Rename it and try again`,
				),
			);
			return;
		}
		const request = new XMLHttpRequest();
		request.open("POST", url);
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

/** Where a file attached to a message in the chat is served, shown in place or downloaded. */
export function chatFileUrl(chatId: string, fileId: string): string {
	return client.urls.chatFiles.file({ params: { chatId, fileId } });
}

/**
 * Removes an upload that will not be sent, so it stops counting toward the
 * files a member can have waiting. Nothing waits on it, and a failure is left
 * alone: the API clears unsent uploads by itself after a day.
 */
export function removeChatFile(chatId: string, fileId: string): void {
	Effect.runPromise(client.api.chats.removeFile({ params: { chatId, fileId } })).catch(() => {});
}

/**
 * The address to upload `file` to, or nothing when its name breaks the API's
 * rules. The URL is checked against those rules as it is built. A media type
 * the API won't take is left out, as is a missing one, so the API works the
 * type out from the name.
 */
function buildUploadUrl(chatId: string, file: File): string | undefined {
	const build = (query: { name: string; type?: string }) => {
		try {
			return client.urls.chatFiles.uploadFile({ params: { chatId }, query });
		} catch {
			return undefined;
		}
	};
	return (
		(file.type ? build({ name: file.name, type: file.type }) : undefined) ??
		build({ name: file.name })
	);
}

import {
	attachmentNameSchema,
	type FilePart,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_MESSAGE,
	type UploadedAttachment,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { removeChatFile, UploadInterrupted, uploadChatFile } from "@/lib/chat-files.ts";

/** Where a file attached in the composer has got to. */
export type AttachmentUpload =
	/** `progress` runs from 0 to 1. */
	| { state: "uploading"; progress: number }
	/** `attachment` is the file as the API kept it, which may not be as the browser said. */
	| { state: "uploaded"; attachment: UploadedAttachment }
	/**
	 * Not uploaded, or no longer there to send, for `reason`. Only a
	 * `retryable` failure can go differently when the same file is tried again.
	 */
	| { state: "failed"; reason: string; retryable: boolean }
	/** Over `MAX_ATTACHMENT_BYTES`, so it is never uploaded. */
	| { state: "tooLarge" };

/** A file attached in the composer: one chip, which keeps its place in the order attached. */
export type ComposerAttachment = {
	key: string;
	file: File;
	upload: AttachmentUpload;
};

/** The files attached to the message being written, and what can be done with them. */
export type ComposerAttachments = {
	items: readonly ComposerAttachment[];
	/** How many files the latest attach left out, for going over `MAX_ATTACHMENTS_PER_MESSAGE`. */
	leftOut: number;
	/**
	 * Adds files in order, each uploading straight away, up to the limit.
	 * Absent until the chat exists, since that is where they upload to.
	 */
	attach: ((files: readonly File[]) => void) | undefined;
	/** Drops a chip, stopping its upload or removing the file it uploaded. */
	remove: (key: string) => void;
	/** Uploads a file whose failure is retryable again, on the same chip. */
	retry: (key: string) => void;
	/**
	 * Takes the uploaded files out of the composer to send with `draftText`,
	 * or nothing when {@link canSend} says the message cannot go.
	 */
	takeForSending: (draftText: string) => FilesForSending | undefined;
};

/** The files taken to send with a message. */
export type FilesForSending = {
	/** The files as the message will show them, which it can before the API answers. */
	parts: FilePart[];
	/**
	 * Returns the files to the composer, in front of any attached since, when
	 * the message failed with `sendFailure`. Files the API no longer had come
	 * back failed, to upload again. After the chat is left they are removed
	 * instead. Only the first call does anything.
	 */
	putBack: (sendFailure: unknown) => void;
};

/** Whether the attached files can go with a message now, and if not, how many hold it up. */
export type SendReadiness = { ready: true } | { ready: false; failed: number; uploading: number };

export function sendReadiness(items: readonly ComposerAttachment[]): SendReadiness {
	const failed = items.filter(
		({ upload }) => upload.state === "failed" || upload.state === "tooLarge",
	).length;
	const uploading = items.filter(({ upload }) => upload.state === "uploading").length;
	return failed === 0 && uploading === 0 ? { ready: true } : { ready: false, failed, uploading };
}

/**
 * Whether a message can be sent: it has text or a file, and every file
 * attached has uploaded, none still going or failed.
 */
export function canSend(draftText: string, items: readonly ComposerAttachment[]): boolean {
	return sendReadiness(items).ready && (draftText.trim() !== "" || items.length > 0);
}

/**
 * The composer's attachments for the chat `conversationId`. Each file uploads as soon
 * as it is attached. They are kept in memory only, so leaving the chat stops
 * the uploads still going, removes the files uploaded and not sent, which
 * would otherwise count toward the files a person can have waiting, and
 * empties the composer for the next chat.
 */
export function useComposerAttachments(conversationId: string | undefined): ComposerAttachments {
	const [items, setItems] = useState<readonly ComposerAttachment[]>([]);
	const [leftOut, setLeftOut] = useState(0);
	// The source of truth, so a handler reads what the last one wrote without waiting for a render.
	const current = useRef<readonly ComposerAttachment[]>([]);
	const inFlight = useRef(new Map<string, AbortController>());
	const nextKey = useRef(0);
	/** The chat the composer is open on: files taken from any other cannot come back. */
	const openChatId = useRef<string | undefined>(undefined);

	function commit(
		change: (items: readonly ComposerAttachment[]) => readonly ComposerAttachment[],
	): void {
		current.current = change(current.current);
		setItems(current.current);
	}

	function setUpload(key: string, upload: AttachmentUpload): void {
		commit((items) => items.map((item) => (item.key === key ? { ...item, upload } : item)));
	}

	function startUpload(key: string, file: File): void {
		if (!conversationId) return;
		const controller = new AbortController();
		inFlight.current.set(key, controller);
		setUpload(key, { state: "uploading", progress: 0 });
		const stillWanted = () => inFlight.current.get(key) === controller;
		uploadChatFile({
			conversationId,
			file,
			signal: controller.signal,
			onProgress: (progress) => {
				if (stillWanted()) setUpload(key, { state: "uploading", progress });
			},
		}).then(
			(uploaded) => {
				// Removed while it was finishing: it has to go from the API too.
				if (!stillWanted()) {
					removeChatFile(conversationId, uploaded.id);
					return;
				}
				inFlight.current.delete(key);
				setUpload(key, { state: "uploaded", attachment: uploaded });
			},
			(failure: unknown) => {
				if (!stillWanted()) return;
				inFlight.current.delete(key);
				setUpload(key, uploadFailure(failure));
			},
		);
	}

	function attach(files: readonly File[]): void {
		const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - current.current.length);
		const added = files.slice(0, room).map(
			(file): ComposerAttachment => ({
				key: `attachment-${nextKey.current++}`,
				file,
				upload: uploadToStart(file),
			}),
		);
		setLeftOut(files.length - added.length);
		commit((items) => [...items, ...added]);
		for (const item of added) {
			if (item.upload.state === "uploading") startUpload(item.key, item.file);
		}
	}

	function remove(key: string): void {
		const item = current.current.find((candidate) => candidate.key === key);
		if (!item) return;
		inFlight.current.get(key)?.abort();
		inFlight.current.delete(key);
		if (conversationId && item.upload.state === "uploaded") {
			removeChatFile(conversationId, item.upload.attachment.id);
		}
		setLeftOut(0);
		commit((items) => items.filter((candidate) => candidate.key !== key));
	}

	function retry(key: string): void {
		const item = current.current.find((candidate) => candidate.key === key);
		if (item?.upload.state !== "failed" || !item.upload.retryable) return;
		startUpload(key, item.file);
	}

	function takeForSending(draftText: string): FilesForSending | undefined {
		const taken = current.current;
		if (!conversationId || !canSend(draftText, taken)) return undefined;
		const takenFrom = conversationId;
		const fileIds = uploadedFileIds(taken);
		setLeftOut(0);
		commit(() => []);
		let returned = false;
		return {
			parts: taken.flatMap(({ upload }): FilePart[] =>
				upload.state === "uploaded" ? [{ type: "file", ...upload.attachment }] : [],
			),
			putBack: (sendFailure) => {
				if (returned) return;
				returned = true;
				if (openChatId.current !== takenFrom) {
					for (const fileId of fileIds) removeChatFile(takenFrom, fileId);
					return;
				}
				if (!isFileGoneRefusal(sendFailure)) {
					commit((items) => [...taken, ...items]);
					return;
				}
				// The API attaches all of a message's files or none, without saying
				// which was missing, so each uploads again. The ones still there go,
				// so they stop counting toward the files a person can have waiting.
				for (const fileId of fileIds) removeChatFile(takenFrom, fileId);
				commit((items) => [
					...taken.map((item): ComposerAttachment => ({ ...item, upload: FILE_GONE })),
					...items,
				]);
			},
		};
	}

	useEffect(() => {
		openChatId.current = conversationId;
		const uploads = inFlight.current;
		return () => {
			openChatId.current = undefined;
			for (const controller of uploads.values()) controller.abort();
			uploads.clear();
			if (conversationId) {
				for (const fileId of uploadedFileIds(current.current))
					removeChatFile(conversationId, fileId);
			}
			current.current = [];
			setItems([]);
			setLeftOut(0);
		};
	}, [conversationId]);

	return {
		items,
		leftOut,
		attach: conversationId === undefined ? undefined : attach,
		remove,
		retry,
		takeForSending,
	};
}

const decodeAttachmentName = Schema.decodeUnknownOption(attachmentNameSchema);

/** Where a newly attached file starts: uploading, or refused before it goes. */
function uploadToStart(file: File): AttachmentUpload {
	if (file.size > MAX_ATTACHMENT_BYTES) return { state: "tooLarge" };
	if (Option.isNone(decodeAttachmentName(file.name))) {
		return {
			state: "failed",
			reason:
				"Its name is too long or has characters that can't be used. Rename it and attach it again.",
			retryable: false,
		};
	}
	return { state: "uploading", progress: 0 };
}

/**
 * Why an upload failed, and whether trying again could work: it can after the
 * connection drops, the API has trouble of its own, or a person has too many
 * files waiting, but not when the API refuses the file itself.
 */
function uploadFailure(failure: unknown): AttachmentUpload {
	if (failure instanceof UploadInterrupted) {
		return {
			state: "failed",
			reason: "The upload didn't finish. Check your connection and retry.",
			retryable: true,
		};
	}
	if (!isApiFailure(failure)) {
		return { state: "failed", reason: "The upload failed.", retryable: false };
	}
	return {
		state: "failed",
		reason: asSentence(failure.message),
		retryable: failure._tag === "InternalServerError" || failure._tag === "Conflict",
	};
}

const FILE_GONE: AttachmentUpload = {
	state: "failed",
	reason: "It was no longer there when the message was sent. Retry to upload it again.",
	retryable: true,
};

/**
 * Whether a send was refused because a file it carried was gone, such as one
 * the API cleared for waiting too long.
 */
export function isFileGoneRefusal(failure: unknown): boolean {
	return isApiFailure(failure) && failure.error?._tag === "UploadsNotFound";
}

function uploadedFileIds(items: readonly ComposerAttachment[]): string[] {
	return items.flatMap(({ upload }) => (upload.state === "uploaded" ? [upload.attachment.id] : []));
}

/** The API's messages leave off the full stop a sentence beside others needs. */
function asSentence(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

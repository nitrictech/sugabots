import { posix } from "node:path";
import {
	headerNameSchema,
	headerValueSchema,
	MAX_ATTACHMENT_BYTES,
	MAX_URL_CHARACTERS,
} from "@sugabots/contracts";
import { uuidSchema } from "@sugabots/contracts/uuid";
import { type DomainError, userText } from "@sugabots/errors";
import { type Tool, tool } from "ai";
import { Effect, ErrorReporter, Schema, Stream } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { ChatFileStore } from "../../../files/chat-file-store.ts";
import { type EgressHttpClients, EgressRefused } from "../../../providers/network/egress.ts";
import {
	type ComputerAtPlace,
	inComputer,
	MAX_SHARED_FILE_MEGABYTES,
	megabytes,
	readSharableFile,
} from "../computer/tools.ts";
import { type Failed, failed } from "../failed.ts";
import { refusedHeader } from "../http/tools.ts";
import { unreadableFileRefusal } from "../unreadable-file.ts";

/** Longer than a signed URL lives, which is a minute for Linear's. */
const TIMEOUT_MS = 60_000;

/** Of a refused upload's response, which says why, such as an expired signature. */
const MAX_REFUSAL_CHARACTERS = 1_000;

const MAX_CHAT_FILE_MEGABYTES = MAX_ATTACHMENT_BYTES / (1024 * 1024);

type Source = { kind: "chat"; fileId: string } | { kind: "computer"; path: string };

type UploadResult = { status: "uploaded"; bytes: number } | Failed;

/** A service's signed upload address, and what its upload tool tells the model. */
export interface SignedUpload {
	/** Every URL the service signs starts with this; any other is refused. */
	readonly destination: string;
	/** How to get the signed URL and headers, and what to call once the file is up. */
	readonly howTo: string;
}

/** What a turn's upload reads its file from and sends it through. */
export interface UploadSide {
	readonly chatId: string;
	readonly files: Pick<ChatFileStore.Interface, "read">;
	/** Undefined when the turn has no computer, so a path is refused. */
	readonly computer: ComputerAtPlace | undefined;
	readonly upload: EgressHttpClients;
	readonly run: RunEffect<never>;
}

/**
 * A tool that PUTs a file in the chat, or in the computer, to a URL `service`
 * signed, for a connector whose service takes files that way, such as
 * Linear's for attaching a screenshot to an issue. The request is sent from
 * Sugabots, not the computer, so it works without a computer and whatever the
 * computer may reach, and before the URL expires. Only URLs under the
 * service's own destination are accepted, so a file goes nowhere else.
 */
export function signedUploadTool(
	service: SignedUpload,
	{ chatId, files, computer, upload, run }: UploadSide,
): Tool {
	return tool({
		description: `Upload a file to a signed upload URL. ${service.howTo} Give the file in this chat by its id, from the line that names it, or a file in the computer by its path. Pass the URL and every header you were given exactly as given; the file's bytes are sent as they are. Files up to ${MAX_CHAT_FILE_MEGABYTES} MB from the chat or ${MAX_SHARED_FILE_MEGABYTES} MB from the computer.`,
		inputSchema: Schema.Struct({
			file: Schema.optional(
				uuidSchema.annotate({
					description: "The id of a file in this chat. Give this or path.",
				}),
			),
			path: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
					description:
						"A file in the computer, relative to the chat's folder unless it starts with /. Give this or file.",
				}),
			),
			uploadUrl: Schema.String.check(Schema.isMaxLength(MAX_URL_CHARACTERS)).annotate({
				description: "The signed URL to PUT the file to, exactly as given",
			}),
			headers: Schema.Record(headerNameSchema, headerValueSchema)
				.check(Schema.isMaxProperties(20))
				.annotate({
					description: "The headers given for the upload, exactly as given",
				}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ file, path, uploadUrl, headers }, { abortSignal }): Promise<UploadResult> => {
			const source = sourceOf(file, path);
			if ("status" in source) return source;
			if (!isUnder(uploadUrl, service.destination)) {
				return failed(
					userText`That isn't the service's upload address. Use the signed URL it gave you, as given.`,
				);
			}
			const refusal = refusedHeader(headers, undefined);
			if (refusal) return refusal;
			const content =
				source.kind === "chat"
					? await run(chatFileContent(files, chatId, source.fileId), {
							signal: abortSignal,
						})
					: await computerFileContent(computer, source.path, abortSignal);
			if (!(content instanceof Uint8Array)) return content;
			return put(
				upload.for({ baseUrl: service.destination }),
				uploadUrl,
				headers,
				content,
				abortSignal,
				run,
			);
		},
	});
}

/** The one file the call names, or why it names none or two. */
function sourceOf(file: string | undefined, path: string | undefined): Source | Failed {
	if (file !== undefined && path !== undefined) {
		return failed(userText`Give either a file in the chat or a path in the computer, not both.`);
	}
	if (file !== undefined) return { kind: "chat", fileId: file };
	if (path !== undefined) return { kind: "computer", path };
	return failed(userText`Give the file to upload: a file in the chat, or a path in the computer.`);
}

/** Whether `url` is under `destination` once `..` and the like are resolved. */
function isUnder(url: string, destination: string): boolean {
	return URL.canParse(url) && new URL(url).href.startsWith(destination);
}

/** The whole of a file in the chat, refusing one too large before reading it. */
function chatFileContent(
	files: Pick<ChatFileStore.Interface, "read">,
	chatId: string,
	fileId: string,
): Effect.Effect<Uint8Array | Failed> {
	return Effect.gen(function* () {
		const found = yield* files.read({ chatId, fileId });
		if (found.size > MAX_ATTACHMENT_BYTES) {
			return failed(
				userText`The file is ${megabytes(found.size)} MB; files up to ${MAX_CHAT_FILE_MEGABYTES} MB from the chat can be uploaded.`,
			);
		}
		const chunks = yield* Stream.runCollect(found.stream);
		return new Uint8Array(Buffer.concat(chunks));
	}).pipe(Effect.catch((failure) => Effect.map(unreadableFileRefusal(failure), failed)));
}

/** The whole of a file in the computer, read as the bots' user, refusing one too large before reading it. */
async function computerFileContent(
	computer: UploadSide["computer"],
	path: string,
	abortSignal: AbortSignal | undefined,
): Promise<Uint8Array | Failed> {
	if (!computer)
		return failed(userText`This bot has no computer, so only files in the chat can be uploaded.`);
	const absolutePath = posix.resolve(computer.place.folder, path);
	const read = await inComputer(computer, abortSignal, (opened) =>
		readSharableFile(
			opened,
			absolutePath,
			(sizeBytes) =>
				userText`The file is ${megabytes(sizeBytes)} MB; files up to ${MAX_SHARED_FILE_MEGABYTES} MB from the computer can be uploaded.`,
		),
	);
	return "content" in read ? read.content : read;
}

/** PUTs `content` with `headers` as given, and says what the service answered. */
async function put(
	fetch: ReturnType<EgressHttpClients["for"]>,
	url: string,
	headers: Record<string, string>,
	content: Uint8Array,
	abortSignal: AbortSignal | undefined,
	run: RunEffect<never>,
): Promise<UploadResult> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "PUT",
			headers,
			body: content,
			signal: abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout,
		});
	} catch (cause) {
		if (cause instanceof EgressRefused) return failed(cause.userMessage);
		if (timeout.aborted) {
			return failed(
				userText`The upload took longer than ${TIMEOUT_MS / 1000} seconds and was stopped.`,
			);
		}
		throw cause;
	}
	if (response.ok) {
		await response.body?.cancel();
		return { status: "uploaded", bytes: content.byteLength };
	}
	const refusal = new SignedUploadRefused({
		httpStatus: response.status,
		upstreamMessage: (await response.text()).slice(0, MAX_REFUSAL_CHARACTERS),
	});
	await run(Effect.logWarning(refusal.message));
	return failed(refusal.userMessage);
}

export class SignedUploadRefused
	extends Schema.TaggedError<SignedUploadRefused>()("SignedUploadRefused", {
		httpStatus: Schema.Int,
		upstreamMessage: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The signed upload was refused with HTTP ${this.httpStatus}: ${this.upstreamMessage}`;
	}
	get userMessage() {
		return userText`The upload service refused the file with HTTP ${this.httpStatus}. Request a new signed upload address and try again.`;
	}
}

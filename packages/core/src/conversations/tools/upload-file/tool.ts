import { posix } from "node:path";
import {
	headerNameSchema,
	headerValueSchema,
	isClientOwnedHeader,
	MAX_ATTACHMENT_BYTES,
	MAX_URL_CHARACTERS,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { tool } from "ai";
import { Effect, Schema, Stream } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import { type EgressHttpClients, EgressRefused } from "../../../providers/network/egress.ts";
import type { ThreadFiles } from "../../thread-files/thread-files.ts";
import { unreadableFileRefusal } from "../read-thread-file/tool.ts";
import {
	inSandbox,
	MAX_SHARED_FILE_BYTES,
	type OpenSandbox,
	type Place,
} from "../sandbox/tools.ts";

export const UPLOAD_FILE_TOOL = "upload_file";

/**
 * Where files may be uploaded: the signed upload addresses of services agents
 * connect to. A URL signed for one of these is only issued by that service,
 * so a file can go nowhere the agent's connections didn't ask for it.
 */
const UPLOAD_DESTINATIONS = [
	// Linear's `prepare_attachment_upload` and `prepare_file_upload`.
	"https://storage.googleapis.com/uploads.linear.app/",
];

/** Longer than a signed URL lives, which is a minute for Linear's. */
const TIMEOUT_MS = 60_000;

/** Of a refused upload's response, which says why, such as an expired signature. */
const MAX_REFUSAL_CHARACTERS = 1_000;

const MAX_THREAD_FILE_MEGABYTES = MAX_ATTACHMENT_BYTES / (1024 * 1024);
const MAX_SANDBOX_FILE_MEGABYTES = MAX_SHARED_FILE_BYTES / (1024 * 1024);

/** The sandbox and the agent's place in it, when the turn has one. */
export interface SandboxWorkspace {
	readonly open: OpenSandbox;
	readonly place: Place;
}

type Source = { kind: "thread"; fileId: string } | { kind: "sandbox"; path: string };

type UploadResult = { status: "uploaded"; bytes: number } | Failed;

interface Failed {
	status: "failed";
	error: UserText;
}

const failed = (error: UserText): Failed => ({ status: "failed", error });

/**
 * The `upload_file` tool: PUTs a file in the thread, or in the sandbox, to a
 * signed upload URL a connected service gave the agent, such as Linear's for
 * attaching a screenshot to an issue. The request is sent from Sugabots, not
 * the sandbox, so it works without a sandbox and whatever the sandbox may
 * reach, and before the URL expires.
 */
export function uploadFileTool({
	threadId,
	files,
	sandbox,
	upload,
	run,
}: {
	threadId: string;
	files: Pick<ThreadFiles.Interface, "read">;
	/** Undefined when the turn has no sandbox, so a path is refused. */
	sandbox: SandboxWorkspace | undefined;
	upload: EgressHttpClients;
	run: RunEffect<never>;
}) {
	return tool({
		description: `Upload a file to a signed upload URL a connected service gave you, such as the uploadRequest from Linear's prepare_attachment_upload or prepare_file_upload, then finish as that service says. Give the file in this thread by its id, from the line that names it, or a file in the sandbox by its path. Pass the URL and every header the service gave you exactly as given; the file's bytes are sent as they are. Files up to ${MAX_THREAD_FILE_MEGABYTES} MB from the thread or ${MAX_SANDBOX_FILE_MEGABYTES} MB from the sandbox. Only services' own upload addresses are accepted.`,
		inputSchema: Schema.Struct({
			file: Schema.optional(
				Schema.String.check(Schema.isUUID()).annotate({
					description: "The id of a file in this thread. Give this or path.",
				}),
			),
			path: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
					description:
						"A file in the sandbox, relative to the thread's folder unless it starts with /. Give this or file.",
				}),
			),
			url: Schema.String.check(Schema.isMaxLength(MAX_URL_CHARACTERS)).annotate({
				description: "The signed URL to PUT the file to, exactly as the service gave it",
			}),
			headers: Schema.Record(headerNameSchema, headerValueSchema)
				.check(Schema.isMaxProperties(20))
				.annotate({
					description: "The headers the service gave for the upload, exactly as given",
				}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: async ({ file, path, url, headers }, { abortSignal }): Promise<UploadResult> => {
			const source = sourceOf(file, path);
			if ("status" in source) return source;
			const destination = destinationOf(url);
			if (!destination) {
				return failed(
					userText`That isn't an upload address Sugabots sends files to. Use the signed URL a connected service gave you, as given.`,
				);
			}
			if (Object.keys(headers).some(isClientOwnedHeader)) {
				return failed(userText`One of those headers is set by Sugabots itself. Leave it out.`);
			}
			const content =
				source.kind === "thread"
					? await run(threadFileContent(files, threadId, source.fileId))
					: await sandboxFileContent(sandbox, source.path);
			if (!(content instanceof Uint8Array)) return content;
			return put(upload.for({ baseUrl: destination }), url, headers, content, abortSignal);
		},
	});
}

/** The one file the call names, or why it names none or two. */
function sourceOf(file: string | undefined, path: string | undefined): Source | Failed {
	if (file !== undefined && path !== undefined) {
		return failed(userText`Give either a file in the thread or a path in the sandbox, not both.`);
	}
	if (file !== undefined) return { kind: "thread", fileId: file };
	if (path !== undefined) return { kind: "sandbox", path };
	return failed(userText`Give the file to upload: a file in the thread, or a path in the sandbox.`);
}

/** The upload address `url` is under, once `..` and the like are resolved. */
function destinationOf(url: string): string | undefined {
	if (!URL.canParse(url)) return undefined;
	const { href } = new URL(url);
	return UPLOAD_DESTINATIONS.find((destination) => href.startsWith(destination));
}

/** The whole of a file in the thread, refusing one too large before reading it. */
function threadFileContent(
	files: Pick<ThreadFiles.Interface, "read">,
	threadId: string,
	fileId: string,
): Effect.Effect<Uint8Array | Failed> {
	return Effect.gen(function* () {
		const found = yield* files.read({ threadId, fileId });
		if (found.size > MAX_ATTACHMENT_BYTES) {
			return failed(
				userText`The file is ${megabytes(found.size)} MB; files up to ${MAX_THREAD_FILE_MEGABYTES} MB from the thread can be uploaded.`,
			);
		}
		const chunks = yield* Stream.runCollect(found.stream);
		return new Uint8Array(Buffer.concat(chunks));
	}).pipe(Effect.catch((failure) => Effect.map(unreadableFileRefusal(failure), failed)));
}

/** The whole of a file in the sandbox, read as the agents' user, refusing one too large before reading it. */
async function sandboxFileContent(
	sandbox: SandboxWorkspace | undefined,
	path: string,
): Promise<Uint8Array | Failed> {
	if (!sandbox)
		return failed(userText`This bot has no sandbox, so only files in the thread can be uploaded.`);
	const tooLarge = (sizeBytes: number) =>
		failed(
			userText`The file is ${megabytes(sizeBytes)} MB; files up to ${MAX_SANDBOX_FILE_MEGABYTES} MB from the sandbox can be uploaded.`,
		);
	const absolutePath = posix.resolve(sandbox.place.folder, path);
	const read = await inSandbox(sandbox.open, (opened) =>
		Effect.gen(function* () {
			// Its size alone first, so a file too large is never read.
			const { sizeBytes } = yield* opened.readFile(absolutePath, 0);
			if (sizeBytes > MAX_SHARED_FILE_BYTES) return tooLarge(sizeBytes);
			const whole = yield* opened.readFile(absolutePath, MAX_SHARED_FILE_BYTES);
			if (whole.sizeBytes > MAX_SHARED_FILE_BYTES) return tooLarge(whole.sizeBytes);
			return { content: whole.content };
		}),
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
	// The service's own words, such as an expired or mismatched signature.
	const said = (await response.text()).slice(0, MAX_REFUSAL_CHARACTERS);
	return failed(
		userText`The upload was refused with HTTP ${response.status}: ${UserText.unchecked(said)}`,
	);
}

function megabytes(bytes: number): number {
	return Math.round(bytes / 104_857.6) / 10;
}

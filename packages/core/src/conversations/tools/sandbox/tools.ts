import { posix } from "node:path";
import {
	attachmentNameSchema,
	type FilePart,
	MAX_ATTACHMENTS_PER_MESSAGE,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { tool } from "ai";
import { Effect, Schema, Semaphore, Stream } from "effect";
import { contentType as mediaTypeForName } from "mime-types";
import type { BlobStore } from "../../../blob-store/blob-store.ts";
import type { RunEffect } from "../../../database/database.ts";
import type { Ids } from "../../../ids/ids.ts";
import type { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import type { UserFacing } from "../../../user-message.ts";
import type { ThreadFiles } from "../../thread-files/thread-files.ts";
import { MAX_IMAGE_BYTES, SHOWN_IMAGE_FORMATS, shownImageType, withImages } from "../images.ts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "../network-access/tool.ts";
import { unreadableFileRefusal } from "../read-thread-file/tool.ts";
import { type Copy, copyIntoSandbox, safeFileName } from "./attachments.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const READ_FILE_TOOL = "read_file";
export const WRITE_FILE_TOOL = "write_file";
export const COPY_FILE_TO_SANDBOX_TOOL = "copy_file_to_sandbox";
export const SHARE_FILE_TOOL = "share_file";

/**
 * The largest file an agent can share. It is read as the agents' user,
 * through a command that prints it as base64, which holds the whole file in
 * the server's memory on the way out.
 */
const MAX_SHARED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SHARED_FILE_MEGABYTES = MAX_SHARED_FILE_BYTES / (1024 * 1024);

/** Attaches a file, read out of the sandbox, to the reply being written. */
export type AttachToReply = (file: {
	name: string;
	contentType: string;
	content: Uint8Array;
}) => Effect.Effect<FilePart, UserFacing | BlobStore.Failure>;

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
/** Of each stream, kept from the end. */
const MAX_OUTPUT_CHARACTERS = 20_000;
const MAX_READ_CHARACTERS = 100_000;
/** Enough for {@link MAX_READ_CHARACTERS} of any text: UTF-8 takes up to four bytes a character. */
const MAX_READ_BYTES = MAX_READ_CHARACTERS * 4;
const MAX_WRITE_CHARACTERS = 1_000_000;

/**
 * Where a turn works in the pod's sandbox. Both are under the workspace, so
 * they last as long as the sandbox does and come across when it moves to a
 * new image.
 */
export interface Place {
	/**
	 * The thread's folder: where commands start and relative paths resolve.
	 * Shared by the agents in the thread, and kept between its turns.
	 */
	readonly folder: string;
	/** The agent's home, its `HOME`: its own across every thread in the pod. */
	readonly home: string;
}

export function placeOf(turn: { threadId: string; agentId: string }): Place {
	return {
		folder: `${Sandboxes.WORKSPACE_DIRECTORY}/threads/${turn.threadId}`,
		home: `${Sandboxes.WORKSPACE_DIRECTORY}/agents/${turn.agentId}`,
	};
}

/**
 * Opens the pod's sandbox on the first call that needs it, and reuses it for
 * the rest of the turn, so a turn that never runs anything never starts one.
 */
export type OpenSandbox = () => Promise<PodSandboxes.Opened>;

/**
 * The pod's sandbox, opened once per turn. A failed opening is not kept, so
 * the next call tries again.
 */
export function openOncePerTurn(open: () => Promise<PodSandboxes.Opened>): OpenSandbox {
	let opening: Promise<PodSandboxes.Opened> | undefined;
	let told = false;
	return async () => {
		opening ??= open().catch((cause: unknown) => {
			opening = undefined;
			throw cause;
		});
		const opened = await opening;
		// What happened to the sandbox is news only to the first call that sees it.
		if (told) return { ...opened, arrival: "running" };
		told = true;
		return opened;
	};
}

/** What the agent is told when a tool couldn't do its work. */
interface Failed {
	status: "failed";
	error: UserText;
}

/** Runs `work` in the pod's sandbox, turning a refusal it can act on into a result. */
async function inSandbox<A>(
	openSandbox: OpenSandbox,
	work: (
		sandbox: Sandboxes.Sandbox,
	) => Effect.Effect<A, Sandboxes.Unavailable | Sandboxes.FileFailed>,
): Promise<(A & { note?: UserText }) | Failed> {
	let opened: PodSandboxes.Opened;
	try {
		opened = await openSandbox();
	} catch (cause) {
		if (cause instanceof Sandboxes.Unavailable)
			return { status: "failed", error: cause.userMessage };
		throw cause;
	}
	const note = arrivalNote(opened.arrival);
	return Effect.runPromise(
		work(opened.sandbox).pipe(
			Effect.map((result) => ({ ...result, ...(note ? { note } : {}) })),
			Effect.catchTags({
				SandboxUnavailable: (failure) =>
					Effect.succeed<Failed>({ status: "failed", error: failure.userMessage }),
				SandboxFileFailed: (failure) =>
					Effect.succeed<Failed>({
						status: "failed",
						error: userText`${failure.reason}: ${UserText.unchecked(failure.path)}`,
					}),
			}),
		),
	);
}

/** What the agent needs to know about how its sandbox came back, if anything. */
function arrivalNote(arrival: PodSandboxes.Opened["arrival"]): UserText | undefined {
	switch (arrival) {
		case "rebooted":
			return userText`The sandbox was paused since it was last used. Its files are kept, but programs that were running have stopped.`;
		case "replaced":
			return userText`This is a new sandbox: the pod's earlier one is gone, and its files with it, including any work that wasn't pushed.`;
		case "made":
		case "running":
		case "resumed":
			return undefined;
	}
}

/** A path the agent gave, relative to the thread's folder unless it starts with `/`. */
function absolute(place: Place, path: string) {
	return posix.resolve(place.folder, path);
}

function shown(output: Sandboxes.CapturedOutput) {
	return output.truncated ? `[earlier output left out]\n${output.text}` : output.text;
}

const pathIn = (place: Place) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
		description: `A path in the sandbox, relative to ${place.folder} unless it starts with /`,
	});

export function runCommandTool(openSandbox: OpenSandbox, place: Place) {
	return tool({
		description: `Run a bash command in the pod's sandbox, a Linux machine shared by the agents in this pod. Commands start in this thread's folder, ${place.folder}: a scratchpad kept between the thread's turns and shared with the other agents in the thread, so clone and build here. Your home, ${place.home} (also $HOME), is your own and kept across every thread in the pod: keep notes, settings and tools you want everywhere there. Nothing else carries over between commands, so cd or export in the same command. Returns the exit code and the end of stdout and stderr. A command still running at its timeout is stopped. It can't ask a person anything, so pass flags that skip prompts. For web pages, use the browser_ tools. Commands run without a screen; when a task needs one for something other than the browser, and the sandbox has sugabots-desktop, run "sugabots-desktop start" to get a desktop, set the DISPLAY it prints for the programs you start, and use scrot to take screenshots and xdotool to click and type. Stop it with "sugabots-desktop stop <number>" when you're done. The sandbox, its browser included, reaches only the hosts the turn's note lists; to reach another the task needs, call ${REQUEST_NETWORK_ACCESS_TOOL}.`,
		inputSchema: Schema.Struct({
			command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
				description: "The bash command to run",
			}),
			timeout_seconds: Schema.Int.check(
				Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS }),
			)
				.annotate({
					description: "How long it may run before it is stopped",
					default: DEFAULT_TIMEOUT_SECONDS,
				})
				.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_TIMEOUT_SECONDS))),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ command, timeout_seconds }) =>
			inSandbox(openSandbox, (sandbox) =>
				sandbox
					.exec(`bash -lc ${Sandboxes.shellQuoted(command)}`, {
						cwd: place.folder,
						env: { HOME: place.home },
						timeout: `${timeout_seconds} seconds`,
						maxOutputCharacters: MAX_OUTPUT_CHARACTERS,
					})
					.pipe(
						Effect.map((execution) => ({
							...(execution.exitCode === null
								? { timedOut: true }
								: { exitCode: execution.exitCode }),
							stdout: shown(execution.stdout),
							stderr: shown(execution.stderr),
						})),
					),
			),
	});
}

/** The extensions of images read_file shows the model. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function readFileTool(openSandbox: OpenSandbox, place: Place, acceptsImages: boolean) {
	return tool({
		description: acceptsImages
			? `Read a file in the pod's sandbox: a text file as text, or an image (${SHOWN_IMAGE_FORMATS}) to look at, such as a screenshot. Long text files are cut off; use run_command with head, tail or grep for parts of them.`
			: `Read a text file in the pod's sandbox. Long files are cut off; use run_command with head, tail or grep for parts of them.`,
		inputSchema: Schema.Struct({ path: pathIn(place) }).pipe(
			Schema.toStandardSchemaV1,
			Schema.toStandardJSONSchemaV1,
		),
		execute: ({ path }) => {
			const asImage =
				acceptsImages && IMAGE_EXTENSIONS.has(posix.extname(path).slice(1).toLowerCase());
			return inSandbox(openSandbox, (sandbox) =>
				sandbox.readFile(absolute(place, path), asImage ? MAX_IMAGE_BYTES : MAX_READ_BYTES).pipe(
					Effect.map(({ content, sizeBytes }): Record<string, unknown> => {
						if (asImage) {
							if (sizeBytes > MAX_IMAGE_BYTES) {
								return {
									status: "failed",
									error: `The image is larger than ${MAX_IMAGE_BYTES} bytes.`,
								};
							}
							const mediaType = shownImageType(content);
							return mediaType === undefined
								? {
										status: "failed",
										error: `The file isn't a ${SHOWN_IMAGE_FORMATS} image, whatever its name says.`,
									}
								: {
										text: `The image at ${absolute(place, path)}.`,
										images: [{ data: Buffer.from(content).toString("base64"), mediaType }],
									};
						}
						const text = new TextDecoder().decode(content);
						return text.length > MAX_READ_CHARACTERS || sizeBytes > content.length
							? {
									content: text.slice(0, MAX_READ_CHARACTERS),
									truncated: `Only the first ${MAX_READ_CHARACTERS} characters of this ${sizeBytes}-byte file are shown.`,
								}
							: { content: text };
					}),
				),
			);
		},
		toModelOutput: ({ output }) => withImages(output, acceptsImages),
	});
}

/**
 * Copies a file in the thread into the thread's folder in the sandbox, when
 * the agent wants to work on it there, and says where the copy is. The file
 * is looked up first, so an id that names none never starts the sandbox.
 */
export function copyFileToSandboxTool({
	openSandbox,
	place,
	threadId,
	files,
	ids,
	run,
}: {
	openSandbox: OpenSandbox;
	place: Place;
	threadId: string;
	files: Pick<ThreadFiles.Interface, "read">;
	ids: Ids.Interface;
	run: RunEffect<never>;
}) {
	return tool({
		description: `Copy a file in this thread, such as one a person attached, into the thread's folder in the pod's sandbox, to work on it with commands. Give the file's id, from the line that names it. Returns the copy's path, relative to the thread's folder. A file already copied is left as it is, with any changes made to it, and \`alreadyCopied\` says so; to start again from the file in the thread, remove the copy and copy the file again.`,
		inputSchema: Schema.Struct({
			file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
				description: "The file's id, from the line that names it",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ file }) =>
			run(
				files.read({ threadId, fileId: file }).pipe(
					Effect.flatMap((found) =>
						Effect.promise(() =>
							inSandbox(openSandbox, (sandbox) => copyThreadFile(sandbox, place, found, ids)),
						),
					),
					Effect.catch(refusedRead),
				),
			),
	});
}

/** Copies `found` into the sandbox, reading its bytes only when there is no copy yet. */
function copyThreadFile(
	sandbox: Sandboxes.Sandbox,
	place: Place,
	found: ThreadFiles.StoredFile,
	ids: Ids.Interface,
): Effect.Effect<Copy | Failed, Sandboxes.Unavailable | Sandboxes.FileFailed> {
	const content = Effect.map(Stream.runCollect(found.stream), (chunks) => Buffer.concat(chunks));
	return copyIntoSandbox(sandbox, place.folder, found, content, ids).pipe(
		// The file can still go while it is read, such as with its thread.
		Effect.catchTags({
			ThreadFileNotFound: refusedRead,
			BlobStoreUnavailable: refusedRead,
			BlobStoreRejected: refusedRead,
		}),
	);
}

function refusedRead(failure: ThreadFiles.FileNotFound | BlobStore.Failure) {
	return Effect.map(
		unreadableFileRefusal(failure),
		(error): Failed => ({ status: "failed", error }),
	);
}

/**
 * Shows people a file from the sandbox: it is attached to the agent's reply,
 * where people see it as soon as it is. One file at a time, since each is
 * held whole on its way out.
 */
export function shareFileTool(openSandbox: OpenSandbox, place: Place, attach: AttachToReply) {
	const oneAtATime = Semaphore.makeUnsafe(1);
	return tool({
		description: `Share a file from the pod's sandbox with the people in this chat, such as a chart, picture or spreadsheet you made: it is attached to your reply as soon as you call this, an image shown as a picture and anything else offered to download. Never paste a file's contents, base64 or a link to it into your reply instead. Files up to ${MAX_SHARED_FILE_MEGABYTES} MB, at most ${MAX_ATTACHMENTS_PER_MESSAGE} on one reply.`,
		inputSchema: Schema.Struct({
			path: pathIn(place),
			name: Schema.optional(
				attachmentNameSchema.annotate({
					description: "The name people see, such as chart.png. The file's own name unless given.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ path, name }) =>
			inSandbox(openSandbox, (sandbox) =>
				oneAtATime.withPermits(1)(shareFrom(sandbox, absolute(place, path), name, attach)),
			),
	});
}

/** What sharing a file tells the agent: the name people see it under, and its id. */
interface Shared {
	shared: string;
	file: string;
	note: UserText;
}

/** Reads the file at `path` as the agents' user, then attaches it to the reply, refusing one too large. */
function shareFrom(
	sandbox: Sandboxes.Sandbox,
	path: string,
	name: string | undefined,
	attach: AttachToReply,
): Effect.Effect<Shared | Failed, Sandboxes.Unavailable | Sandboxes.FileFailed> {
	const tooLarge = (sizeBytes: number): Failed => ({
		status: "failed",
		error: userText`The file is ${Math.round(sizeBytes / 104_857.6) / 10} MB; files up to ${MAX_SHARED_FILE_MEGABYTES} MB can be shared.`,
	});
	return Effect.gen(function* () {
		// Its size alone first, so a file too large is never read.
		const { sizeBytes } = yield* sandbox.readFile(path, 0);
		if (sizeBytes > MAX_SHARED_FILE_BYTES) return tooLarge(sizeBytes);
		const read = yield* sandbox.readFile(path, MAX_SHARED_FILE_BYTES);
		if (read.sizeBytes > MAX_SHARED_FILE_BYTES) return tooLarge(read.sizeBytes);
		const shownName = safeFileName(name ?? posix.basename(path));
		const contentType =
			shownImageType(read.content) ?? (mediaTypeForName(shownName) || "application/octet-stream");
		return yield* attach({ name: shownName, contentType, content: read.content }).pipe(
			Effect.map((file): Shared | Failed => ({
				shared: file.name,
				file: file.id,
				note: userText`People see it under your reply now; it needn't be described again.`,
			})),
			Effect.catchTags({
				BlobStoreUnavailable: (failure) =>
					notKept(failure, userText`The file couldn't be kept right now. Try again shortly.`),
				BlobStoreRejected: (failure) =>
					notKept(failure, userText`The workspace's file storage refused the file.`),
			}),
			Effect.catch((failure) =>
				Effect.succeed<Failed>({ status: "failed", error: failure.userMessage }),
			),
		);
	});
}

/** Logs why the file store couldn't keep a shared file, and tells the agent `error`. */
function notKept(failure: BlobStore.Failure, error: UserText) {
	return Effect.logWarning("Keeping a file an agent shared failed", failure).pipe(
		Effect.as<Failed>({ status: "failed", error }),
	);
}

export function writeFileTool(openSandbox: OpenSandbox, place: Place) {
	return tool({
		description: `Write a text file in the pod's sandbox, replacing it if it exists and making its directories.`,
		inputSchema: Schema.Struct({
			path: pathIn(place),
			content: Schema.String.check(Schema.isMaxLength(MAX_WRITE_CHARACTERS)).annotate({
				description: "The whole of the file's new content",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ path, content }) =>
			inSandbox(openSandbox, (sandbox) =>
				sandbox
					.writeFile(absolute(place, path), new TextEncoder().encode(content))
					.pipe(Effect.as({ written: absolute(place, path) })),
			),
	});
}

/**
 * The hosts the sandbox reaches, for the turn's note rather than
 * `run_command`'s description: they change between turns, and the tools lead
 * the provider's cached prompt.
 */
export function allowedHostsNote(allowedHosts: readonly string[]): string {
	return `The pod's sandbox, its browser included, connects only to these hosts (*. covers a domain's subdomains): ${allowedHosts.join(", ")}. A connection to any other host fails as if it weren't there: a name that doesn't resolve, a TLS error or an empty reply. To reach one the task needs, call ${REQUEST_NETWORK_ACCESS_TOOL}.`;
}

import { posix } from "node:path";
import {
	attachmentNameSchema,
	computerDiskLevel,
	computerDiskPercent,
	type FilePart,
	formatDiskSize,
	MAX_ATTACHMENTS_PER_MESSAGE,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { tool } from "ai";
import { Effect, Schema, Semaphore, Stream } from "effect";
import { contentType as mediaTypeForName } from "mime-types";
import type { BlobStore } from "../../../blob-store/blob-store.ts";
import { BOT_CACHES } from "../../../computers/computer-disk-clearing.ts";
import { Computers } from "../../../computers/computers.ts";
import type { ProjectComputers } from "../../../computers/project-computers.ts";
import type { RunEffect } from "../../../database/database.ts";
import type { ChatFileStore } from "../../../files/chat-file-store.ts";
import type { Ids } from "../../../ids/ids.ts";
import type { UserFacing } from "../../../user-message.ts";
import { type Failed, failed } from "../failed.ts";
import { HOST_REQUEST_TOOL } from "../host-request/name.ts";
import { MAX_IMAGE_BYTES, SHOWN_IMAGE_FORMATS, shownImageType, withImages } from "../images.ts";
import { unreadableFileRefusal } from "../read-chat-file/tool.ts";
import { type Copy, copyIntoComputer, safeFileName } from "./attachments.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const READ_FILE_TOOL = "read_file";
export const WRITE_FILE_TOOL = "write_file";
export const COPY_FILE_TO_COMPUTER_TOOL = "copy_file_to_computer";
export const SHARE_FILE_TOOL = "share_file";

/**
 * The largest file a bot can share. It is read as the bots' user,
 * through a command that prints it as base64, which holds the whole file in
 * the server's memory on the way out.
 */
export const MAX_SHARED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SHARED_FILE_MEGABYTES = MAX_SHARED_FILE_BYTES / (1024 * 1024);

/** Attaches a file, read out of the computer, to the reply being written. */
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
 * Where a turn works in the computer of the project it works in. Both are under `/workspace`, so
 * they last as long as the computer does and come across when it moves to a
 * new image.
 */
export interface Place {
	/**
	 * The chat's folder: where commands start and relative paths resolve.
	 * Kept between the bot's turns in the chat.
	 */
	readonly folder: string;
	/** The bot's home folder, its `HOME`: kept across all its chats. */
	readonly home: string;
}

export function placeOf(turn: { chatId: string; botId: string }): Place {
	return {
		folder: `${Computers.CHATS_DIRECTORY}/${turn.chatId}`,
		home: `${Computers.BOTS_DIRECTORY}/${turn.botId}`,
	};
}

/**
 * Opens the computer of the project the turn works in on the first call that needs it, and reuses it for
 * the rest of the turn, so a turn that never runs anything never starts one.
 */
export type OpenComputer = () => Promise<ProjectComputers.Opened>;

/** The computer of the project the turn works in, as the turn's tools reach it. */
export interface TurnComputer {
	readonly open: OpenComputer;
	/** Runs work in the computer with the turn's services, such as its tracing and logging. */
	readonly run: RunEffect<never>;
}

/** {@link TurnComputer}, with the bot's place in it, for tools that work from there. */
export interface ComputerAtPlace extends TurnComputer {
	readonly place: Place;
}

/**
 * The computer of the project the turn works in, opened once per turn. A failed opening is not kept, so
 * the next call tries again.
 */
export function openOncePerTurn(open: () => Promise<ProjectComputers.Opened>): OpenComputer {
	let opening: Promise<ProjectComputers.Opened> | undefined;
	let told = false;
	return async () => {
		opening ??= open().catch((cause: unknown) => {
			opening = undefined;
			throw cause;
		});
		const opened = await opening;
		// What happened to the computer is news only to the first call that sees it.
		if (told) return { ...opened, arrival: "running" };
		told = true;
		return opened;
	};
}

/**
 * Runs `work` in the computer of the project the turn works in, turning a refusal it can act on into a
 * result. The work is interrupted when `abortSignal`, the tool call's, aborts,
 * as it does when the turn is interrupted.
 */
export async function inComputer<A>(
	computer: TurnComputer,
	abortSignal: AbortSignal | undefined,
	work: (
		computer: Computers.Computer,
	) => Effect.Effect<A, Computers.Unavailable | Computers.FileFailed>,
): Promise<(A & { note?: UserText }) | Failed> {
	let opened: ProjectComputers.Opened;
	try {
		opened = await computer.open();
	} catch (cause) {
		if (cause instanceof Computers.Unavailable) return failed(cause.userMessage);
		throw cause;
	}
	const note = arrivalNote(opened.arrival);
	return computer.run(
		work(opened.computer).pipe(
			Effect.map((result) => ({ ...result, ...(note ? { note } : {}) })),
			Effect.catchTags({
				ComputerUnavailable: (failure) => Effect.succeed(failed(failure.userMessage)),
				ComputerFileFailed: (failure) =>
					Effect.succeed(failed(userText`${failure.reason}: ${UserText.unchecked(failure.path)}`)),
			}),
		),
		{ signal: abortSignal },
	);
}

/** What the bot needs to know about how its computer came back, if anything. */
function arrivalNote(arrival: ProjectComputers.Opened["arrival"]): UserText | undefined {
	switch (arrival) {
		case "rebooted":
			return userText`Your computer was asleep since it was last used. Its files are kept, but programs that were running have stopped.`;
		case "replaced":
			return userText`This is a new computer: your earlier one is gone, and its files with it, including any work that wasn't pushed.`;
		case "made":
		case "running":
		case "resumed":
			return undefined;
	}
}

/** A path the bot gave, relative to the chat's folder unless it starts with `/`. */
function absolute(place: Place, path: string) {
	return posix.resolve(place.folder, path);
}

function shown(output: Computers.CapturedOutput) {
	return output.truncated ? `[earlier output left out]\n${output.text}` : output.text;
}

const pathIn = (place: Place) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
		description: `A path on your computer, relative to ${place.folder} unless it starts with /`,
	});

export function runCommandTool(computer: TurnComputer, place: Place) {
	return tool({
		description: `Run a bash command on your computer: the Linux machine of the project this chat is in, which its bots share. Commands start in this chat's folder, ${place.folder}: kept between your turns in the chat, so clone and build here. Your home folder, ${place.home} (also $HOME), is kept across all your chats in the project: keep notes, settings and tools you want everywhere there. When the computer's disk runs short, the folders of finished chats, such as ended automation runs and chats marked resolved, are cleared, and so are the caches in your home (${BOT_CACHES.map((cache) => `~/${cache}`).join(", ")}): push anything that must outlast its chat, or keep it elsewhere in your home. Nothing else carries over between commands, so cd or export in the same command. Returns the exit code and the end of stdout and stderr. A command still running at its timeout is stopped. Your turn waits on every command, and no one hears from you until it ends, so keep waits short: sleep or poll for a few seconds while something starts up, never minutes for a member or another system to respond. When something will only be ready later, say what you're waiting for and end your turn. It can't ask a member anything, so pass flags that skip prompts. For web pages, use the browser_ tools. Commands run without a screen; when a chat needs one for something other than the browser, and the computer has sugabots-desktop, run "sugabots-desktop start" to get a desktop, set the DISPLAY it prints for the programs you start, and use scrot to take screenshots and xdotool to click and type. Stop it with "sugabots-desktop stop <number>" when you're done.`,
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
		execute: ({ command, timeout_seconds }, { abortSignal }) =>
			inComputer(computer, abortSignal, (opened) =>
				opened
					.exec(`bash -lc ${Computers.shellQuoted(command)}`, {
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

export function readFileTool(computer: TurnComputer, place: Place, acceptsImages: boolean) {
	return tool({
		description: acceptsImages
			? `Read a file on your computer: a text file as text, or an image (${SHOWN_IMAGE_FORMATS}) to look at, such as a screenshot. Long text files are cut off; use run_command with head, tail or grep for parts of them.`
			: `Read a text file on your computer. Long files are cut off; use run_command with head, tail or grep for parts of them.`,
		inputSchema: Schema.Struct({ path: pathIn(place) }).pipe(
			Schema.toStandardSchemaV1,
			Schema.toStandardJSONSchemaV1,
		),
		execute: ({ path }, { abortSignal }) => {
			const asImage =
				acceptsImages && IMAGE_EXTENSIONS.has(posix.extname(path).slice(1).toLowerCase());
			return inComputer(computer, abortSignal, (opened) =>
				opened.readFile(absolute(place, path), asImage ? MAX_IMAGE_BYTES : MAX_READ_BYTES).pipe(
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
 * Copies a file in the chat into the chat's folder in the computer, when
 * the bot wants to work on it there, and says where the copy is. The file
 * is looked up first, so an id that names none never starts the computer.
 */
export function copyFileToComputerTool({
	computer,
	place,
	chatId,
	files,
	ids,
}: {
	computer: TurnComputer;
	place: Place;
	chatId: string;
	files: Pick<ChatFileStore.Interface, "read">;
	ids: Ids.Interface;
}) {
	return tool({
		description: `Copy a file in this chat, such as one a member attached, into the chat's folder on your computer, to work on it with commands. Give the file's id, from the line that names it. Returns the copy's path, relative to the chat's folder. A file already copied is left as it is, with any changes made to it, and \`alreadyCopied\` says so; to start again from the file in the chat, remove the copy and copy the file again.`,
		inputSchema: Schema.Struct({
			file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
				description: "The file's id, from the line that names it",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ file }, { abortSignal }) =>
			computer.run(
				files.read({ chatId, fileId: file }).pipe(
					Effect.flatMap((found) =>
						Effect.promise((interrupted) =>
							inComputer(computer, interrupted, (opened) =>
								copyChatFile(opened, place, found, ids),
							),
						),
					),
					Effect.catch(refusedRead),
				),
				{ signal: abortSignal },
			),
	});
}

/** Copies `found` into the computer, reading its bytes only when there is no copy yet. */
function copyChatFile(
	computer: Computers.Computer,
	place: Place,
	found: ChatFileStore.StoredFile,
	ids: Ids.Interface,
): Effect.Effect<Copy | Failed, Computers.Unavailable | Computers.FileFailed> {
	const content = Effect.map(Stream.runCollect(found.stream), (chunks) => Buffer.concat(chunks));
	return copyIntoComputer(computer, place.folder, found, content, ids).pipe(
		// The file can still go while it is read, such as with its chat.
		Effect.catchTags({
			ChatFileNotFound: refusedRead,
			BlobStoreUnavailable: refusedRead,
			BlobStoreRejected: refusedRead,
		}),
	);
}

function refusedRead(failure: ChatFileStore.FileNotFound | BlobStore.Failure) {
	return Effect.map(unreadableFileRefusal(failure), failed);
}

/**
 * Shows members a file from the computer: it is attached to the bot's reply,
 * where members see it as soon as it is. One file at a time, since each is
 * held whole on its way out.
 */
export function shareFileTool(computer: TurnComputer, place: Place, attach: AttachToReply) {
	const oneAtATime = Semaphore.makeUnsafe(1);
	return tool({
		description: `Share a file from your computer with everyone in this chat, such as a chart, picture or spreadsheet you made: it is attached to your reply as soon as you call this, an image shown as a picture and anything else offered to download. Never paste a file's contents, base64 or a link to it into your reply instead. Files up to ${MAX_SHARED_FILE_MEGABYTES} MB, at most ${MAX_ATTACHMENTS_PER_MESSAGE} on one reply.`,
		inputSchema: Schema.Struct({
			path: pathIn(place),
			name: Schema.optional(
				attachmentNameSchema.annotate({
					description: "The name members see, such as chart.png. The file's own name unless given.",
				}),
			),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ path, name }, { abortSignal }) =>
			inComputer(computer, abortSignal, (opened) =>
				oneAtATime.withPermits(1)(shareFrom(opened, absolute(place, path), name, attach)),
			),
	});
}

/** What sharing a file tells the bot: the name members see it under, and its id. */
interface Shared {
	shared: string;
	file: string;
	note: UserText;
}

/** Reads the file at `path` as the bots' user, then attaches it to the reply, refusing one too large. */
function shareFrom(
	computer: Computers.Computer,
	path: string,
	name: string | undefined,
	attach: AttachToReply,
): Effect.Effect<Shared | Failed, Computers.Unavailable | Computers.FileFailed> {
	return Effect.gen(function* () {
		const read = yield* readSharableFile(
			computer,
			path,
			(sizeBytes) =>
				userText`The file is ${megabytes(sizeBytes)} MB; files up to ${MAX_SHARED_FILE_MEGABYTES} MB can be shared.`,
		);
		if ("status" in read) return read;
		const shownName = safeFileName(name ?? posix.basename(path));
		const contentType =
			shownImageType(read.content) ?? (mediaTypeForName(shownName) || "application/octet-stream");
		return yield* attach({ name: shownName, contentType, content: read.content }).pipe(
			Effect.map((file): Shared | Failed => ({
				shared: file.name,
				file: file.id,
				note: userText`Members see it under your reply now; it needn't be described again.`,
			})),
			Effect.catchTags({
				BlobStoreUnavailable: (failure) =>
					notKept(failure, userText`The file couldn't be kept right now. Try again shortly.`),
				BlobStoreRejected: (failure) =>
					notKept(failure, userText`The workspace's file storage refused the file.`),
			}),
			Effect.catch((failure) => Effect.succeed(failed(failure.userMessage))),
		);
	});
}

/**
 * The whole of the file at `path`, read as the bots' user, or why not: one
 * over {@link MAX_SHARED_FILE_BYTES} is refused with `tooLarge` of its size,
 * and is never read.
 */
export function readSharableFile(
	computer: Computers.Computer,
	path: string,
	tooLarge: (sizeBytes: number) => UserText,
): Effect.Effect<{ content: Uint8Array } | Failed, Computers.Unavailable | Computers.FileFailed> {
	return Effect.gen(function* () {
		// Its size alone first, so a file too large is never read.
		const { sizeBytes } = yield* computer.readFile(path, 0);
		if (sizeBytes > MAX_SHARED_FILE_BYTES) return failed(tooLarge(sizeBytes));
		const read = yield* computer.readFile(path, MAX_SHARED_FILE_BYTES);
		if (read.sizeBytes > MAX_SHARED_FILE_BYTES) return failed(tooLarge(read.sizeBytes));
		return { content: read.content };
	});
}

/** `bytes` in megabytes, to one decimal place. */
export function megabytes(bytes: number): number {
	return Math.round(bytes / 104_857.6) / 10;
}

/** Logs why the file store couldn't keep a shared file, and tells the bot `error`. */
function notKept(failure: BlobStore.Failure, error: UserText) {
	return Effect.logWarning("Keeping a file a bot shared failed", failure).pipe(
		Effect.as(failed(error)),
	);
}

export function writeFileTool(computer: TurnComputer, place: Place) {
	return tool({
		description: `Write a text file on your computer, replacing it if it exists and making its directories.`,
		inputSchema: Schema.Struct({
			path: pathIn(place),
			content: Schema.String.check(Schema.isMaxLength(MAX_WRITE_CHARACTERS)).annotate({
				description: "The whole of the file's new content",
			}),
		}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
		execute: ({ path, content }, { abortSignal }) =>
			inComputer(computer, abortSignal, (opened) =>
				opened
					.writeFile(absolute(place, path), new TextEncoder().encode(content))
					.pipe(Effect.as({ written: absolute(place, path) })),
			),
	});
}

/**
 * A warning for the turn's note when the computer's disk was close to full
 * when last measured, so the bot frees space before it runs out, and stops
 * when a command fails for lack of it, rather than trying again.
 */
export function diskNote(disk: ProjectComputers.MeasuredDisk | undefined): string | undefined {
	if (!disk || computerDiskLevel(disk) === "normal") return undefined;
	return `Your computer's disk was ${computerDiskPercent(disk)}% full when last measured: ${formatDiskSize(disk.usedBytes)} of ${formatDiskSize(disk.totalBytes)}. Once it fills, commands that write fail with "No space left on device". Before installing, cloning or building, remove what you no longer need, such as package caches in your home and clones and builds you've finished with. If a command fails for lack of space, don't try it again: tell the chat that your computer's disk is full.`;
}

/**
 * What the computer reaches, for the turn's note rather than
 * `run_command`'s description: they change between turns, and the tools lead
 * the provider's cached prompt.
 */
export function networkNote(reach: Computers.Reach): string {
	const unreachable =
		"fails as if it weren't there: a name that doesn't resolve, a TLS error or an empty reply";
	if (reach.kind === "allowed-hosts-only") {
		return `Your computer, its browser included, connects only to these hosts (*. covers a domain's subdomains): ${reach.hosts.join(", ")}. A connection to any other host ${unreachable}. To reach one the chat needs, call ${HOST_REQUEST_TOOL}.`;
	}
	if (reach.blockedHosts.length === 0) {
		return "Your computer, its browser included, connects to any host on the internet.";
	}
	return `Your computer, its browser included, connects to any host on the internet except these, which the workspace blocked (*. covers a domain's subdomains): ${reach.blockedHosts.join(", ")}. A connection to one ${unreachable}.`;
}

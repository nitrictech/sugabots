import {
	computerDiskLevel,
	computerDiskPercent,
	type FilePart,
	formatDiskSize,
	HOST_REQUEST_TOOL,
} from "@sugabots/contracts";
import { MAX_SHARED_FILE_BYTES } from "@sugabots/contracts/operations/computers";
import { type DomainError, UserText, userText } from "@sugabots/errors";
import { Effect } from "effect";
import { Computers } from "../../../computers/computers.ts";
import type { ProjectComputers } from "../../../computers/project-computers.ts";
import type { RunEffect } from "../../../database/database.ts";
import { type Failed, failed } from "../failed.ts";

/*
 * What the tools that work in a turn's computer share: the computer as a
 * step opens it, the bot's place in it, and the notes on it the turn is
 * given. The computer tools themselves are operations (`operations/computers/`),
 * working through `TurnComputers`.
 */

export {
	MAX_SHARED_FILE_BYTES,
	MAX_SHARED_FILE_MEGABYTES,
} from "@sugabots/contracts/operations/computers";

/** The tool that copies a chat's file into the computer, which the chat's history points bots to. */
export const COPY_FILE_TO_COMPUTER_TOOL = "copy_file_to_computer";

/** Attaches a file, read out of the computer, to the reply being written. */
export type AttachToReply = (file: {
	name: string;
	contentType: string;
	content: Uint8Array;
}) => Effect.Effect<FilePart, DomainError>;

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
type OpenComputer = () => Promise<ProjectComputers.Opened>;

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
export function arrivalNote(arrival: ProjectComputers.Opened["arrival"]): UserText | undefined {
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

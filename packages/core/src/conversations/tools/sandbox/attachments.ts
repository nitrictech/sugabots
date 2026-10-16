import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import type { Ids } from "../../../ids/ids.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";

/*
 * A thread's file copied into the thread's sandbox folder, when the agent asks
 * for it, so commands can work on it like any other file. Each goes in a
 * folder of its own id, so two files with the same name never meet and a
 * file's path follows from the file alone. The copy is the agents' to change,
 * so copying a file again leaves it as it is: the file in the thread never
 * changes, so a second copy could only undo their work.
 *
 * The pod's agents share its sandbox, so an agent in one of the pod's threads
 * can read a copy made in another. Everyone who can see one of a pod's chats
 * can see them all, so this lets no person see more than they could.
 */

/** Where the copies are kept, in the thread's folder. */
const ATTACHMENTS_FOLDER = "attachments";

/** Linux limits a file's name to 255 bytes, not characters. */
const MAX_NAME_BYTES = 255;

/** An extension longer than this is more likely part of the name, and isn't kept whole. */
const MAX_EXTENSION_BYTES = 32;

const COMMAND_OPTIONS = { timeout: "30 seconds", maxOutputCharacters: 2_000 } as const;

/** A file in the thread, which has no name when it is a tool's result. */
interface ThreadFile {
	id: string;
	name: string | undefined;
}

/** Where `file` is copied, relative to the thread's folder, where commands start. */
export function sandboxPathOf(file: ThreadFile): string {
	return `${ATTACHMENTS_FOLDER}/${file.id}/${safeFileName(file.name)}`;
}

/**
 * `name`, as a person's computer gave it, made safe as one file name: no
 * folders, nothing hidden or read as a command's option, no characters that
 * break a line or reorder what's shown, and short enough for Linux, keeping
 * its extension.
 */
function safeFileName(name: string | undefined): string {
	const cleaned = (name ?? "")
		.replace(/[/\\\p{Cc}]/gu, "_")
		.replace(/\p{Cf}/gu, "")
		.replace(/^[\s.-]+/u, "")
		.trimEnd();
	return fitted(cleaned || "file");
}

/** `name` cut to {@link MAX_NAME_BYTES} bytes, keeping a short extension whole. */
function fitted(name: string): string {
	if (byteLength(name) <= MAX_NAME_BYTES) return name;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot) : "";
	const kept = byteLength(extension) <= MAX_EXTENSION_BYTES ? extension : "";
	return (
		cutToBytes(name.slice(0, name.length - kept.length), MAX_NAME_BYTES - byteLength(kept)) + kept
	);
}

/** The longest start of `text` that fits in `bytes`, never splitting a character. */
function cutToBytes(text: string, bytes: number): string {
	let cut = "";
	for (const character of text) {
		if (byteLength(cut + character) > bytes) break;
		cut += character;
	}
	return cut;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Where a copy is, relative to the thread's folder, and whether it was there before the call. */
export interface Copy {
	path: string;
	alreadyCopied: boolean;
}

/**
 * Copies `file` into the thread's `folder`, reading its bytes from `content`
 * only when no copy is there yet, and says where the copy is. It is written
 * beside where it goes and moved into place, under a name of its own, so no
 * command finds it half written, even with another agent copying the same
 * file at once.
 */
export function copyIntoSandbox<E>(
	sandbox: Sandboxes.Sandbox,
	folder: string,
	file: ThreadFile,
	content: Effect.Effect<Uint8Array, E>,
	ids: Ids.Interface,
): Effect.Effect<Copy, E | Sandboxes.Unavailable | Sandboxes.FileFailed> {
	const path = sandboxPathOf(file);
	const target = `${folder}/${path}`;
	return Effect.gen(function* () {
		const present = yield* sandbox.exec(
			`test -e ${Sandboxes.shellQuoted(target)}`,
			COMMAND_OPTIONS,
		);
		if (present.exitCode === 0) return { path, alreadyCopied: true };
		const partial = `${folder}/${ATTACHMENTS_FOLDER}/${file.id}/.copying-${yield* ids.random}`;
		yield* content.pipe(
			Effect.flatMap((bytes) => sandbox.writeFile(partial, bytes)),
			Effect.andThen(
				sandbox.exec(
					`mv -f -- ${Sandboxes.shellQuoted(partial)} ${Sandboxes.shellQuoted(target)}`,
					COMMAND_OPTIONS,
				),
			),
			Effect.flatMap((moved) =>
				moved.exitCode === 0
					? Effect.void
					: Effect.fail(
							new Sandboxes.FileFailed({
								path: target,
								reason: userText`The copy couldn't be put in place`,
							}),
						),
			),
			// A copy that didn't make it into place is removed, so no command finds it.
			Effect.onError(() =>
				sandbox
					.exec(`rm -f -- ${Sandboxes.shellQuoted(partial)}`, COMMAND_OPTIONS)
					.pipe(Effect.ignore),
			),
		);
		return { path, alreadyCopied: false };
	});
}

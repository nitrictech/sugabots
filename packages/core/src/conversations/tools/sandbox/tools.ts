import { posix } from "node:path";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { UserMessage } from "../../../user-message.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const READ_FILE_TOOL = "read_file";
export const WRITE_FILE_TOOL = "write_file";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 300;
/** Of each stream, kept from the end. */
const MAX_OUTPUT_CHARACTERS = 20_000;
const MAX_READ_CHARACTERS = 100_000;
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
	error: UserMessage;
}

/** Runs `work` in the pod's sandbox, turning a refusal it can act on into a result. */
async function inSandbox<A>(
	openSandbox: OpenSandbox,
	work: (
		sandbox: Sandboxes.Sandbox,
	) => Effect.Effect<A, Sandboxes.Unavailable | Sandboxes.FileFailed>,
): Promise<(A & { note?: UserMessage }) | Failed> {
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
						error: UserMessage.of`${failure.reason}: ${UserMessage.unchecked(failure.path)}`,
					}),
			}),
		),
	);
}

/** What the agent needs to know about how its sandbox came back, if anything. */
function arrivalNote(arrival: PodSandboxes.Opened["arrival"]): UserMessage | undefined {
	switch (arrival) {
		case "rebooted":
			return UserMessage.of`The sandbox was paused since it was last used. Its files are kept, but programs that were running have stopped.`;
		case "replaced":
			return UserMessage.of`This is a new sandbox: the pod's earlier one is gone, and its files with it, including any work that wasn't pushed.`;
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
	return output.droppedCharacters > 0
		? `[${output.droppedCharacters} earlier characters left out]\n${output.text}`
		: output.text;
}

const pathIn = (place: Place) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
		description: `A path in the sandbox, relative to ${place.folder} unless it starts with /`,
	});

export function runCommandTool(openSandbox: OpenSandbox, place: Place) {
	return tool({
		description: `Run a bash command in the pod's sandbox, a Linux machine shared by the agents in this pod. Commands start in this thread's folder, ${place.folder}: a scratchpad kept between the thread's turns and shared with the other agents in the thread, so clone and build here. Your home, ${place.home} (also $HOME), is your own and kept across every thread in the pod: keep notes, settings and tools you want everywhere there. Nothing else carries over between commands, so cd or export in the same command. Returns the exit code and the end of stdout and stderr. A command still running at its timeout is stopped. It can't ask a person anything, so pass flags that skip prompts. It reaches only the hosts the turn's note lists.`,
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
					.exec(`bash -lc ${shellQuoted(command)}`, {
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

export function readFileTool(openSandbox: OpenSandbox, place: Place) {
	return tool({
		description: `Read a text file in the pod's sandbox. Long files are cut off; use run_command with head, tail or grep for parts of them.`,
		inputSchema: Schema.Struct({ path: pathIn(place) }).pipe(
			Schema.toStandardSchemaV1,
			Schema.toStandardJSONSchemaV1,
		),
		execute: ({ path }) =>
			inSandbox(openSandbox, (sandbox) =>
				sandbox.readFile(absolute(place, path)).pipe(
					Effect.map((bytes) => {
						const text = new TextDecoder().decode(bytes);
						return text.length > MAX_READ_CHARACTERS
							? {
									content: text.slice(0, MAX_READ_CHARACTERS),
									truncated: `Only the first ${MAX_READ_CHARACTERS} of ${text.length} characters are shown.`,
								}
							: { content: text };
					}),
				),
			),
	});
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
	return `The pod's sandbox connects only to these hosts (*. covers a domain's subdomains): ${allowedHosts.join(", ")}. A connection to any other host fails as if it weren't there: a name that doesn't resolve, a TLS error or an empty reply. When the task needs another, say which and why, so a workspace admin can allow it.`;
}

/** `text` as one single-quoted bash word. */
function shellQuoted(text: string) {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

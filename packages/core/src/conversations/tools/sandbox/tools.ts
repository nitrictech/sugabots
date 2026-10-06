import { posix } from "node:path";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { UserMessage } from "../../../user-message.ts";
import { REQUEST_NETWORK_ACCESS_TOOL } from "../network-access/tool.ts";
import { REQUEST_SOFTWARE_TOOL } from "../software/tool.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const READ_FILE_TOOL = "read_file";
export const WRITE_FILE_TOOL = "write_file";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 300;
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
	return output.truncated ? `[earlier output left out]\n${output.text}` : output.text;
}

const pathIn = (place: Place) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
		description: `A path in the sandbox, relative to ${place.folder} unless it starts with /`,
	});

export function runCommandTool(openSandbox: OpenSandbox, place: Place) {
	return tool({
		description: `Run a bash command in the pod's sandbox, a Linux machine shared by the agents in this pod. Commands start in this thread's folder, ${place.folder}: a scratchpad kept between the thread's turns and shared with the other agents in the thread, so clone and build here. Your home, ${place.home} (also $HOME), is your own and kept across every thread in the pod: keep notes, settings and tools you want everywhere there. Nothing else carries over between commands, so cd or export in the same command. Returns the exit code and the end of stdout and stderr. A command still running at its timeout is stopped. It can't ask a person anything, so pass flags that skip prompts. For web pages, use the browser_ tools. Commands run without a screen; when a task needs one for something other than the browser, and the sandbox has sugabots-desktop, run "sugabots-desktop start" to get a desktop, set the DISPLAY it prints for the programs you start, and use scrot to take screenshots and xdotool to click and type. Stop it with "sugabots-desktop stop <number>" when you're done. The sandbox, its browser included, reaches only the hosts the turn's note lists; to reach another the task needs, call ${REQUEST_NETWORK_ACCESS_TOOL}. For software the sandbox lacks, run "nix shell nixpkgs#<name> -c <command>" for this once, or call ${REQUEST_SOFTWARE_TOOL} to keep it for the pod.`,
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

/** Images read_file shows the model, by extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};
const MAX_IMAGE_BYTES = 5_000_000;

export function readFileTool(openSandbox: OpenSandbox, place: Place, acceptsImages: boolean) {
	return tool({
		description: acceptsImages
			? `Read a file in the pod's sandbox: a text file as text, or an image (PNG, JPEG, GIF or WebP) to look at, such as a screenshot. Long text files are cut off; use run_command with head, tail or grep for parts of them.`
			: `Read a text file in the pod's sandbox. Long files are cut off; use run_command with head, tail or grep for parts of them.`,
		inputSchema: Schema.Struct({ path: pathIn(place) }).pipe(
			Schema.toStandardSchemaV1,
			Schema.toStandardJSONSchemaV1,
		),
		execute: ({ path }) => {
			const mediaType = IMAGE_TYPES[posix.extname(path).slice(1).toLowerCase()];
			const asImage = mediaType !== undefined && acceptsImages;
			return inSandbox(openSandbox, (sandbox) =>
				sandbox.readFile(absolute(place, path), asImage ? MAX_IMAGE_BYTES : MAX_READ_BYTES).pipe(
					Effect.map(({ content, sizeBytes }): Record<string, unknown> => {
						if (asImage) {
							return sizeBytes > MAX_IMAGE_BYTES
								? {
										status: "failed",
										error: `The image is larger than ${MAX_IMAGE_BYTES} bytes.`,
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

export interface Image {
	/** Base 64. */
	data: string;
	mediaType: string;
}

/**
 * A tool's output as the model is given it: a result with images as text and
 * images, when the model can take them; anything else as it is.
 */
export function withImages(output: unknown, acceptsImages: boolean) {
	if (!output || typeof output !== "object" || !("images" in output)) {
		return { type: "json" as const, value: output as never };
	}
	const { images, ...rest } = output as { images: readonly Image[] } & Record<string, unknown>;
	const text =
		typeof rest.text === "string"
			? [rest.note, rest.text].filter((part) => typeof part === "string").join("\n\n")
			: JSON.stringify(rest);
	if (!acceptsImages) return { type: "text" as const, value: text };
	return {
		type: "content" as const,
		value: [
			{ type: "text" as const, text },
			...images.map((image) => ({
				type: "image-data" as const,
				data: image.data,
				mediaType: image.mediaType,
			})),
		],
	};
}

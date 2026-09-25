import { posix } from "node:path";
import { type ToolSet, tool } from "ai";
import { Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import { Sandbox } from "../../../sandboxes/sandbox.ts";
import type { TurnSandbox } from "./turn-sandbox.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const READ_FILE_TOOL = "read_file";
export const WRITE_FILE_TOOL = "write_file";
export const EDIT_FILE_TOOL = "edit_file";
export const OPEN_BROWSER_TOOL = "open_browser";

export const SANDBOX_TOOLS = [
	RUN_COMMAND_TOOL,
	READ_FILE_TOOL,
	WRITE_FILE_TOOL,
	EDIT_FILE_TOOL,
	OPEN_BROWSER_TOOL,
];

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const MAX_COMMAND_TIMEOUT_SECONDS = 600;
/** Per stream, from the end. Both streams together stay under what a tool call stores. */
const MAX_COMMAND_OUTPUT_CHARACTERS = 20_000;
/** Larger files are for commands like `head`, `sed -n` or `rg`, not for reading whole. */
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_READ_LINES = 2_000;

/**
 * The tools that work in the pod's sandbox: run a command, and read, write
 * and edit files. Every agent in the pod shares the machine, so what one
 * leaves in `/workspace` the others see.
 *
 * Files go through the provider's file API rather than `cat` and `tee`: a
 * command costs a round trip to start, and the file API is also the only way
 * to write bytes without quoting them into a shell.
 */
export function sandboxTools(turn: TurnSandbox, run: RunEffect): ToolSet {
	const sandbox = () => turn.sandbox().catch(explainFailure);
	/** A result, with the note about a resumed sandbox if this is the first since it woke. */
	const withResumeNote = <Output extends object>(output: Output) => {
		const note = turn.takeResumeNote();
		return note ? { ...output, sandboxNote: note } : output;
	};
	const readBytes = async (path: string) =>
		run((await sandbox()).readFile(path)).catch(explainFailure);
	const readText = async (path: string) => new TextDecoder().decode(await readBytes(path));
	const writeText = async (path: string, text: string) =>
		run((await sandbox()).writeFile(path, new TextEncoder().encode(text))).catch(explainFailure);

	return {
		[RUN_COMMAND_TOOL]: tool({
			description: `Run a shell command (bash) in this pod's sandbox, a Linux machine shared by the pod's agents. Use it to run programs and tests, install packages, and use git. It starts in ${Sandbox.WORKSPACE_DIRECTORY}, where work belongs. Each call is a fresh shell, so pass a working directory rather than relying on an earlier cd. Only some hosts on the internet can be reached. The end of long output is kept, where errors usually are.`,
			inputSchema: Schema.Struct({
				command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
				cwd: Schema.optional(
					Schema.String.check(Schema.isMaxLength(1_024)).annotate({
						description: `Directory to run in, absolute or relative to ${Sandbox.WORKSPACE_DIRECTORY}`,
					}),
				),
				timeoutSeconds: Schema.optional(
					Schema.Int.check(
						Schema.isGreaterThanOrEqualTo(1),
						Schema.isLessThanOrEqualTo(MAX_COMMAND_TIMEOUT_SECONDS),
					).annotate({
						description: `Stop the command after this long. ${DEFAULT_COMMAND_TIMEOUT_SECONDS} when left out.`,
					}),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ command, cwd, timeoutSeconds }, { abortSignal }) => {
				const machine = await sandbox();
				const execution = await run(
					machine.exec(command, {
						cwd: resolvePath(cwd ?? "."),
						timeoutSeconds: timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
						maxOutputCharacters: MAX_COMMAND_OUTPUT_CHARACTERS,
						signal: abortSignal,
					}),
				).catch(explainFailure);
				return withResumeNote({
					exitCode: execution.exitCode,
					...(execution.exitCode === null
						? { note: "The command did not finish: it timed out or was stopped." }
						: {}),
					stdout: describeOutput(execution.stdout),
					stderr: describeOutput(execution.stderr),
				});
			},
		}),
		[READ_FILE_TOOL]: tool({
			description: `Read a text file in the sandbox, with line numbers. Paths are absolute or relative to ${Sandbox.WORKSPACE_DIRECTORY}. For a long file, read the part you need with offset and limit, or search it with rg through run_command.`,
			inputSchema: Schema.Struct({
				path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
				offset: Schema.optional(
					Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
						description: "The first line to read, counting from 1",
					}),
				),
				limit: Schema.optional(
					Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
						description: `How many lines to read. ${DEFAULT_READ_LINES} when left out.`,
					}),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ path, offset = 1, limit = DEFAULT_READ_LINES }) => {
				const absolute = resolvePath(path);
				const bytes = await readBytes(absolute);
				if (bytes.length > MAX_READ_BYTES) {
					throw new Error(
						`${absolute} is ${bytes.length} bytes, more than read_file reads (${MAX_READ_BYTES}). Use run_command with head, sed -n or rg to read the part you need.`,
					);
				}
				if (bytes.includes(0)) {
					throw new Error(`${absolute} is a binary file (${bytes.length} bytes), not text.`);
				}
				const lines = new TextDecoder().decode(bytes).split("\n");
				const shown = lines.slice(offset - 1, offset - 1 + limit);
				return withResumeNote({
					path: absolute,
					totalLines: lines.length,
					content: shown.map((line, index) => `${offset + index}\t${line}`).join("\n"),
					...(offset - 1 + shown.length < lines.length
						? { more: `Lines ${offset + shown.length} to ${lines.length} not shown.` }
						: {}),
				});
			},
		}),
		[WRITE_FILE_TOOL]: tool({
			description: `Write a file in the sandbox, replacing it if it exists and making its directories. Paths are absolute or relative to ${Sandbox.WORKSPACE_DIRECTORY}. To change part of an existing file, use edit_file instead.`,
			inputSchema: Schema.Struct({
				path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
				content: Schema.String.check(Schema.isMaxLength(MAX_READ_BYTES)),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ path, content }) => {
				const absolute = resolvePath(path);
				await writeText(absolute, content);
				return withResumeNote({ path: absolute, characters: content.length });
			},
		}),
		[OPEN_BROWSER_TOOL]: tool({
			description:
				"Open a web page in the browser on the sandbox's desktop, which people in the pod can watch. Use it to show them a page, or a site you are running in the sandbox (http://localhost:<port>). It opens a new window and returns straight away; only some internet hosts are reachable.",
			inputSchema: Schema.Struct({
				url: Schema.String.check(
					Schema.isMaxLength(2_048),
					Schema.isPattern(/^https?:\/\//, { message: "An http or https address" }),
				),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ url }) => {
				const machine = await sandbox();
				const desktop = await run(
					machine.exec("pgrep -x Xvfb >/dev/null", {
						cwd: Sandbox.WORKSPACE_DIRECTORY,
						timeoutSeconds: 10,
						maxOutputCharacters: 200,
					}),
				).catch(explainFailure);
				if (desktop.exitCode !== 0) {
					throw new Error(
						"This pod's sandbox has no desktop to open a browser on. A workspace admin can switch its image to one with a desktop.",
					);
				}
				await run(
					machine.launch(`firefox-esr --new-window "$${BROWSER_URL_VARIABLE}"`, {
						[BROWSER_URL_VARIABLE]: url,
					}),
				).catch(explainFailure);
				return withResumeNote({
					opened: url,
					note: "It can take a few seconds to appear. People watching the pod's desktop see it there.",
				});
			},
		}),
		[EDIT_FILE_TOOL]: tool({
			description:
				"Change part of a text file in the sandbox by replacing exact text. oldText must appear in the file exactly once, including its whitespace, unless replaceAll is set; include enough surrounding lines to make it unique. Read the file first.",
			inputSchema: Schema.Struct({
				path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
				oldText: Schema.String.check(Schema.isMinLength(1)),
				newText: Schema.String,
				replaceAll: Schema.optional(Schema.Boolean),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ path, oldText, newText, replaceAll = false }) => {
				const absolute = resolvePath(path);
				const current = await readText(absolute);
				const occurrences = current.split(oldText).length - 1;
				if (occurrences === 0) {
					throw new Error(
						`oldText does not appear in ${absolute}. Read the file and copy the text exactly.`,
					);
				}
				if (occurrences > 1 && !replaceAll) {
					throw new Error(
						`oldText appears ${occurrences} times in ${absolute}. Include more of the surrounding text so it appears once, or set replaceAll.`,
					);
				}
				await writeText(
					absolute,
					current.replaceAll(oldText, () => newText),
				);
				return withResumeNote({ path: absolute, replacements: occurrences });
			},
		}),
	};
}

/** Carries the address to the browser, so it is never quoted into the command line. */
const BROWSER_URL_VARIABLE = "SUGABOTS_BROWSER_URL";

function resolvePath(path: string): string {
	return posix.resolve(Sandbox.WORKSPACE_DIRECTORY, path);
}

function describeOutput(output: Sandbox.CapturedOutput): string {
	return output.droppedCharacters > 0
		? `[${output.droppedCharacters} earlier characters not shown]\n${output.text}`
		: output.text;
}

/**
 * What the agent is told when the sandbox or a file in it fails. The recording
 * wrapper passes a thrown error's message to the model as the call's result.
 */
function explainFailure(failure: unknown): never {
	if (!isTagged(failure)) throw failure;
	switch (failure._tag) {
		case "SandboxFileFailed":
			throw new Error(`${failure.path}: ${failure.reason}`);
		case "SandboxLost":
			throw new Error(
				`This pod's sandbox is gone: ${failure.reason} Whatever was in it is lost, and a new one is not made automatically. Tell the people here.`,
			);
		case "SandboxProviderUnavailable":
			throw new Error(
				"Sandboxes were switched off for this workspace. Tell the people here; a workspace admin can switch them back on.",
			);
		default:
			throw new Error(
				"The sandbox could not be reached just now. Try again shortly, or tell the people here.",
				{ cause: failure },
			);
	}
}

function isTagged(value: unknown): value is { _tag: string; path?: string; reason?: string } {
	return typeof value === "object" && value !== null && "_tag" in value;
}

import { type MessagePart, messagePreview, type ToolCallPart } from "@sugabots/contracts";
import { BROWSER_TOOL_PREFIX, stepLabel } from "@/lib/tool-names.ts";

/*
 * A reply's tool calls as the tool line lists them once opened: in runs under
 * what the bot said it was about to do, each call written as what it did to
 * what ("Read image.png", "Ran ls -la"), rather than as the tool's name and
 * its raw output.
 *
 * The built-in tools are matched by key, as `@/lib/tool-names.ts` does; a
 * connection's tool, or a built-in one not listed here, is named by its key and
 * the first argument that reads as its subject.
 */

/** Calls made one after another, under what the bot said just before the first of them. */
export interface ToolStepRun {
	/** The narration that introduced them, as one line: "Checking the uploaded screenshots". */
	narration?: string;
	calls: ToolCallPart[];
}

/** What a call did, in words: an action, and what it acted on when its input says. */
export interface ToolStep {
	action: string;
	subject?: { text: string; asCode: boolean };
}

export function toolStepRuns(parts: readonly MessagePart[]): ToolStepRun[] {
	const runs: ToolStepRun[] = [];
	parts.forEach((part, index) => {
		if (part.type !== "tool_call") return;
		const before = parts[index - 1];
		const last = runs.at(-1);
		if (before?.type === "tool_call" && last) {
			last.calls.push(part);
			return;
		}
		const narration = before?.type === "text" ? narrationLine(before.text) : undefined;
		runs.push({ narration, calls: [part] });
	});
	return runs;
}

/** Narration reads "Now let me get the cycle:"; standing over its calls, it loses the colon. */
function narrationLine(text: string): string | undefined {
	const line = messagePreview(text).replace(/:\s*$/, "");
	return line === "" ? undefined : line;
}

/** `fileNames` names the thread's files by id, as the calls that read them refer to them. */
export function describeStep(call: ToolCallPart, fileNames: ReadonlyMap<string, string>): ToolStep {
	const input = asRecord(call.input);
	const output = asRecord(call.output);
	const fileName = (id: unknown) => (typeof id === "string" ? fileNames.get(id) : undefined);

	switch (call.tool) {
		case "run_command":
			return step("Ran", code(firstLine(input.command)), "Ran a command");
		case "read_file":
			return step("Read", code(input.path), "Read a file");
		case "write_file":
			return step("Wrote", code(input.path), "Wrote a file");
		case "copy_file_to_sandbox":
			return step("Copied", name(fileName(input.file)), "Copied a file to the sandbox");
		case "share_file":
			return step(
				"Shared",
				name(output.shared ?? input.name ?? baseName(input.path)),
				"Shared a file",
			);
		case "read_thread_file":
			// A long tool result is kept as a file too, and has no name in the thread.
			return step("Read", name(fileName(input.file)), "Read a long result");
		case "web_search":
			return step("Searched the web for", name(input.query), "Searched the web");
		case "web_fetch":
			return step("Read", name(pageTitle(output)) ?? code(withoutScheme(input.url)), "Read a page");
		case "tool_search":
			return step("Looked for tools to", name(input.query), "Looked for tools");
		case "search_history":
			return step("Searched the thread for", name(input.query), "Read back through the thread");
		case "list_threads":
			return step("Looked for threads about", name(input.title), "Listed the pod's threads");
		case "read_thread":
			return input.query === undefined
				? step("Read", name(asRecord(output.thread).title), "Read another thread")
				: step("Searched another thread for", name(input.query), "Searched another thread");
		case "read_docs":
			return step("Read the docs on", name(input.page), "Read the docs");
		case "artifact_list":
			return { action: "Listed artifacts" };
		case "artifact_read":
			return step("Read", name(output.title), "Read an artifact");
		case "artifact_write":
			return input.artifactId === undefined
				? step("Created", name(output.title ?? input.title), "Created an artifact")
				: step("Rewrote", name(output.title ?? input.title), "Rewrote an artifact");
		case "artifact_edit":
			return step("Edited", name(output.title), "Edited an artifact");
		case "list_routines":
			return { action: "Listed its routines" };
		case "create_routine":
			return step("Set up the routine", name(input.name), "Set up a routine");
		case "update_routine":
			return step("Changed the routine", name(input.name), "Changed a routine");
		case "save_instructions":
			return { action: "Saved its instructions" };
		case "request_network_access":
			return step("Asked to reach", code(input.host), "Asked to reach a host");
		case "workspace_access":
			return step("Checked the access of", name(input.person), "Checked a person's access");
	}
	const action = stepLabel(call.tool);
	if (call.tool.startsWith(BROWSER_TOOL_PREFIX)) {
		return { action, subject: code(withoutScheme(input.url)) };
	}
	return { action, subject: name(SUBJECT_ARGUMENTS.map((key) => input[key]).find(isWords)) };
}

/**
 * A call's input and output as its row shows them opened. Each is text when
 * the tool's input or output is mostly one piece of text (a command, a file),
 * and otherwise the value itself, for `ToolCallValue` to lay out.
 */
export interface StepDetails {
	input?: unknown;
	/** The input's other arguments, when `input` is only its main text: a command's timeout. */
	otherArguments?: unknown;
	output?: unknown;
	/** Why `output` is not all of it: the server stores only the start of a very long one. */
	outputCut?: string;
}

/** What a call was given and what came back. A call still running, or that failed, has no output yet. */
export function stepDetails(call: ToolCallPart): StepDetails {
	const stored = storedOutput(call.output);
	const output = asRecord(stored.output);
	const inputWithText = (textKey: string) => {
		const { [textKey]: text, ...rest } = asRecord(call.input);
		return { input: textOf(text), otherArguments: shown(rest) };
	};
	const cut = stored.cut === undefined ? {} : { outputCut: stored.cut };
	switch (call.tool) {
		case "run_command":
			return {
				...inputWithText("command"),
				output: stored.output === null ? undefined : commandOutput(output),
				...cut,
			};
		case "read_file":
			return {
				...inputWithText("path"),
				output: textOf(output.content) ?? shown(stored.output),
				...cut,
			};
		case "write_file":
			return { ...inputWithText("content"), output: shown(stored.output), ...cut };
		case "read_thread_file":
			return {
				input: shown(call.input),
				output: textOf(output.lines) ?? shown(stored.output),
				...cut,
			};
	}
	return { input: shown(call.input), output: shown(outputValue(stored.output)), ...cut };
}

/**
 * What a tool answered, out of the envelope an MCP server answers in
 * (`{ content: [{ type: "text", text }], structuredContent }`): its structured
 * content, or its text, read as JSON when it is JSON. Any other output as it is.
 */
export function outputValue(output: unknown): unknown {
	const answer = asRecord(output);
	if (answer.structuredContent !== undefined) return answer.structuredContent;
	if (!Array.isArray(answer.content)) return output;
	const parts = answer.content.map(asRecord);
	if (!parts.every((part) => part.type === "text" && typeof part.text === "string")) return output;
	return parseIfJson(parts.map((part) => part.text).join("\n"));
}

function parseIfJson(text: string): unknown {
	if (!/^\s*[[{]/.test(text)) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * The output as stored: whole, or, past what the server keeps, the start of its
 * JSON as `{ truncated, characters, preview }`, which reads as that start.
 */
function storedOutput(output: unknown): { output: unknown; cut?: string } {
	const stored = asRecord(output);
	if (stored.truncated !== true || typeof stored.preview !== "string") return { output };
	const characters =
		typeof stored.characters === "number" ? ` of ${stored.characters.toLocaleString()}` : "";
	return {
		output: stored.preview,
		cut: `Only the first ${stored.preview.length.toLocaleString()}${characters} characters were kept.`,
	};
}

/** What a command printed: its stdout, then its stderr. */
function commandOutput(output: Record<string, unknown>): string {
	const printed = [output.stdout, output.stderr].filter(isWords).map((text) => text.trimEnd());
	return printed.length === 0 ? "No output" : printed.join("\n");
}

/** The value, or nothing for no value or an empty object. */
function shown(value: unknown): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object" && Object.keys(value).length === 0) return undefined;
	return value;
}

function textOf(value: unknown): string | undefined {
	return isWords(value) ? value : undefined;
}

/** The arguments a connection's tool is most often about, most telling first. */
const SUBJECT_ARGUMENTS = ["query", "title", "name", "url", "path"] as const;

function step(action: string, subject: ToolStep["subject"], otherwise: string): ToolStep {
	return subject ? { action, subject } : { action: otherwise };
}

function code(value: unknown): ToolStep["subject"] {
	return isWords(value) ? { text: value, asCode: true } : undefined;
}

function name(value: unknown): ToolStep["subject"] {
	return isWords(value) ? { text: value, asCode: false } : undefined;
}

function isWords(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function firstLine(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim().split("\n")[0] : undefined;
}

function baseName(value: unknown): string | undefined {
	return typeof value === "string" ? value.split("/").at(-1) : undefined;
}

function withoutScheme(value: unknown): string | undefined {
	return typeof value === "string" ? value.replace(/^https?:\/\//, "") : undefined;
}

function pageTitle(output: Record<string, unknown>): unknown {
	return asRecord(output.page).title;
}

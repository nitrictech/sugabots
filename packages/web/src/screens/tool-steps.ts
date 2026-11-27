import { SugabotsIcon } from "@sugabots/avatars";
import { type MessagePart, messagePreview, type ToolCallPart } from "@sugabots/contracts";
import { FileText, Globe, MessageSquare, Monitor, SquareTerminal, Wrench, Zap } from "lucide-react";
import type { ComponentType } from "react";
import type { MarkedConnector } from "@/lib/connectors.ts";
import { capitalise, countOf, listNames } from "@/lib/name-list.ts";
import {
	BROWSER_TOOL_PREFIX,
	BUILT_IN_HANDLE,
	connectorLabel,
	FILE_TOOL_PREFIX,
	splitToolKey,
	stepLabel,
	wordsFromKey,
} from "@/lib/tool-names.ts";
import { awaitsApproval } from "./tool-activity.ts";

/*
 * A reply's tool calls as the tool line says them: in one line over the reply
 * (`toolLineText`), and once it is opened, in runs under what the bot said it
 * was about to do, each call written as what it did to what ("Read
 * image.png", "Ran ls -la") with a note on how it went (`noteOf`), rather
 * than as the tool's name and its raw output.
 *
 * What the bot says just before a call is narration ("Now let me get the
 * cycle:"). The chat leaves it out, where it would read as a sentence
 * pointing at nothing; the tool line shows it over the calls it introduced.
 *
 * The built-in tools are matched by key, as `@/lib/tool-names.ts` does; a
 * connector's tool, or a built-in one not listed here, is named by its key and
 * the first argument that reads as its subject.
 */

/** Calls made one after another, under what the bot said just before the first of them. */
interface ToolStepRun {
	/** The narration that introduced them, as one line: "Checking the uploaded screenshots". */
	narration?: string;
	calls: ToolCallPart[];
}

/** What a call did, in words: an action, and what it acted on when its input says. */
interface ToolStep {
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

/** `fileNames` names the chat's files by id, as the calls that read them refer to them. */
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
		case "copy_file_to_computer":
			return step("Copied", name(fileName(input.file)), "Copied a file to the computer");
		case "share_file":
			return step(
				"Shared",
				name(output.shared ?? input.name ?? baseName(input.path)),
				"Shared a file",
			);
		case "read_chat_file":
			// A long tool result is kept as a file too, and has no name in the chat.
			return step("Read", name(fileName(input.file)), "Read a long result");
		case "web_search":
			return step("Searched the web for", name(input.query), "Searched the web");
		case "web_fetch":
			return step("Read", name(pageTitle(output)) ?? code(withoutScheme(input.url)), "Read a page");
		case "tool_search":
			return step("Looked for tools to", name(input.query), "Looked for tools");
		case "search_history":
			return step("Searched the chat for", name(input.query), "Read back through the chat");
		case "read_docs":
			return step("Read the docs on", name(input.page), "Read the docs");
		case "file_list":
			return { action: "Listed files" };
		case "file_read":
			return step("Read", name(output.title), "Read a file");
		case "file_write":
			return input.fileId === undefined
				? step("Created", name(output.title ?? input.title), "Created a file")
				: step("Rewrote", name(output.title ?? input.title), "Rewrote a file");
		case "file_edit":
			return step("Edited", name(output.title), "Edited a file");
		case "list_automations":
			return { action: "Listed its automations" };
		case "create_automation":
			return step("Set up the automation", name(input.name), "Set up an automation");
		case "update_automation":
			return step("Changed the automation", name(input.name), "Changed an automation");
		case "mark_resolved":
			return { action: "Marked the chat resolved" };
		case "start_chat":
			return step("Started the chat", name(input.title), "Started a chat");
		case "save_instructions":
			return { action: "Saved its instructions" };
		case "request_host":
			return step("Asked to reach", code(input.host), "Asked to reach a host");
		case "workspace_role":
			return step("Checked the role of", name(input.member), "Checked a member's role");
	}
	const action = stepLabel(call.tool);
	if (call.tool.startsWith(BROWSER_TOOL_PREFIX)) {
		return { action, subject: code(withoutScheme(input.url)) };
	}
	// A file in the chat, such as one a connector uploads, is named as the chat names it.
	const subject = fileName(input.file) ?? SUBJECT_ARGUMENTS.map((key) => input[key]).find(isWords);
	return { action, subject: name(subject) };
}

/** An icon by a call's line: a Lucide icon, or a mark drawn the same way. */
export type StepIcon = ComponentType<{ strokeWidth?: number }>;

/**
 * The icon a call to one of the product's own tools shows by its line: its
 * family's, for what its tools work on, such as files, the computer or chats,
 * and the Sugabots icon for Sugabots itself: its docs, the workspace and the
 * bot's own settings. A tool in no family has the wrench.
 */
export function stepIcon(call: ToolCallPart): StepIcon {
	// The bot's browser runs on the project's computer, whose desktop shows it.
	if (call.tool.startsWith(BROWSER_TOOL_PREFIX)) return Monitor;
	if (call.tool.startsWith(FILE_TOOL_PREFIX)) return FileText;
	return TOOL_FAMILIES.find((family) => family.tools.includes(call.tool))?.icon ?? Wrench;
}

/** The product's own tools by family, beyond those whose names give theirs (the browser tools and the file tools). */
const TOOL_FAMILIES: readonly { icon: StepIcon; tools: readonly string[] }[] = [
	// The computer's files, and the chat's, are files too.
	{ icon: FileText, tools: ["read_file", "write_file", "share_file", "read_chat_file"] },
	{ icon: Monitor, tools: ["copy_file_to_computer"] },
	{ icon: SquareTerminal, tools: ["run_command"] },
	{ icon: Globe, tools: ["web_search", "web_fetch", "request_host"] },
	{ icon: MessageSquare, tools: ["start_chat", "mark_resolved", "search_history"] },
	{ icon: Zap, tools: ["list_automations", "create_automation", "update_automation"] },
	// Sugabots itself: its docs and guide, the workspace, and the bot's own settings.
	{
		icon: SugabotsIcon,
		tools: [
			"read_docs",
			"workspace_guide",
			"create_project",
			"workspace_role",
			"save_instructions",
		],
	},
];

/**
 * A call's input and output as its row shows them opened. Each is text when
 * the tool's input or output is mostly one piece of text (a command, a file),
 * and otherwise the value itself, for `ToolCallValue` to lay out.
 */
interface StepDetails {
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
		case "read_chat_file":
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
function outputValue(output: unknown): unknown {
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

/** The arguments a connector's tool is most often about, most telling first. */
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

/** The tool source a call reached, by name: the connector, or the built-in tool itself ("Web search"). */
export function toolSourceOf(call: ToolCallPart, connector?: MarkedConnector): string {
	const { handle } = splitToolKey(call.tool);
	if (call.tool.startsWith(BROWSER_TOOL_PREFIX)) return "Browser";
	if (call.tool.startsWith(FILE_TOOL_PREFIX)) return "Files";
	return handle === BUILT_IN_HANDLE
		? wordsFromKey(call.tool)
		: connectorLabel(handle, connector?.name);
}

/**
 * The line's words. Finished calls are "used"; then, at most one of what the
 * reply is stopped on: a call waiting for approval, one still running, or one
 * that was refused.
 */
export function toolLineText(
	calls: readonly ToolCallPart[],
	markedConnectors: ReadonlyMap<string, MarkedConnector>,
): string {
	const toolSources = (matching: (call: ToolCallPart) => boolean) =>
		listNames(
			[
				...new Set(
					calls
						.filter(matching)
						.map((call) =>
							toolSourceOf(call, markedConnectors.get(splitToolKey(call.tool).handle)),
						),
				),
			],
			{ maxNamed: Number.POSITIVE_INFINITY },
		);
	const denied = (call: ToolCallPart) => call.approval?.status === "denied";
	const waiting = awaitsApproval;
	// An allowed call is as good as running: its turn starts it a moment later.
	const running = (call: ToolCallPart) =>
		call.status === "running" ||
		(call.status === "awaiting_approval" && call.approval?.status === "allowed");
	const finished = (call: ToolCallPart) =>
		(call.status === "completed" || call.status === "failed") && !denied(call);

	const used = toolSources(finished);
	const tail = calls.some(waiting)
		? `waiting on ${toolSources(waiting)} approval`
		: calls.some(running)
			? `using ${toolSources(running)}`
			: calls.some(denied)
				? `${toolSources(denied)} denied`
				: undefined;

	if (!tail) {
		const totalMs = calls.filter(finished).reduce((sum, call) => sum + durationOf(call), 0);
		return `Used ${used} for ${formatTotal(totalMs)}`;
	}
	return used ? `Used ${used}, ${tail}` : capitalise(tail);
}

function durationOf(call: ToolCallPart): number {
	if (!call.finishedAt) return 0;
	return Math.max(new Date(call.finishedAt).getTime() - new Date(call.startedAt).getTime(), 0);
}

/**
 * What the calls took together: `32s`. Rounded to the second, because the
 * total is there to be read at a glance rather than added up.
 */
function formatTotal(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${Math.round(ms / 1_000)}s`;
}

/**
 * What there is to say about how a call went beyond what it did: that it is
 * waiting, running, was refused or failed and why, or how many results it
 * found. Nothing, for a call that simply worked.
 */
export function noteOf(call: ToolCallPart): { text: string; failed: boolean } | undefined {
	const failed = (text: string) => ({ text, failed: true });
	const said = (text: string) => ({ text, failed: false });
	if (call.approval?.status === "denied") {
		return failed(
			call.approval.decidedByName ? `Denied by ${call.approval.decidedByName}` : "Denied",
		);
	}
	if (call.status === "failed") return failed(call.error ?? "Failed");
	if (awaitsApproval(call)) return said("Waiting for approval");
	if (call.status === "awaiting_approval") {
		return said(
			call.approval?.decidedByName ? `Allowed by ${call.approval.decidedByName}` : "Allowed",
		);
	}
	if (call.status === "running") return said("Running");
	const refusal = refusalIn(call.output);
	if (refusal) return failed(refusal);
	const count = resultCountIn(outputValue(call.output));
	return count === undefined ? undefined : said(countOf(count, "result", "results"));
}

/**
 * Why a tool that answered said no, for the shapes tools refuse in:
 * `{ ok: false, reason }`, `{ status: "refused" | "failed", reason | error }`,
 * `{ refused }`, an MCP server's `{ isError, content }`, and a command's
 * non-zero `exitCode` or timeout.
 */
function refusalIn(output: unknown): string | undefined {
	const answer = asRecord(output);
	const why = [answer.reason, answer.error, answer.message].find(
		(value): value is string => typeof value === "string",
	);
	if (typeof answer.refused === "string") return answer.refused;
	if (answer.ok === false || answer.status === "refused" || answer.status === "failed") {
		return why ?? "Failed";
	}
	if (answer.isError === true) {
		const said = outputValue(output);
		return typeof said === "string" ? said : "Failed";
	}
	if (typeof answer.exitCode === "number" && answer.exitCode !== 0)
		return `Exit ${answer.exitCode}`;
	if (answer.timedOut === true) return "Timed out";
	return undefined;
}

/** How many things a call found: its output's list, or the one list inside it. Images it was shown are not results. */
function resultCountIn(output: unknown): number | undefined {
	if (Array.isArray(output)) return output.length;
	if (output === null || typeof output !== "object") return undefined;
	const list = Object.entries(output).find(
		([key, value]) => key !== "images" && Array.isArray(value),
	)?.[1] as unknown[] | undefined;
	return list?.length;
}

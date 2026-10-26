import {
	type CollaborationPart,
	type FilePart,
	type Message,
	type MessageReplyTo,
	messageAuthorName,
	type ToolCallPart,
} from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { READ_THREAD_FILE_TOOL } from "../tools/read-thread-file/tool.ts";
import { COPY_FILE_TO_SANDBOX_TOOL } from "../tools/sandbox/tools.ts";
import { TOOL_SEARCH } from "../tools/tool-search/tool.ts";

/** The tool an agent searches its thread's older history with. */
export const SEARCH_HISTORY_TOOL = "search_history";

/** How much of a tool call's input and output the agent's history keeps. */
const DESCRIBED_INPUT_CHARACTERS = 200;
const DESCRIBED_OUTPUT_CHARACTERS = 500;
/**
 * What `search_history` found is kept longer: it is the older history the
 * agent went looking for, and clipped to a few hundred characters it would
 * have to search again on its next turn.
 */
const DESCRIBED_HISTORY_SEARCH_CHARACTERS = 4_000;

/**
 * A message as prose, with each collaboration and tool call written where it
 * happened so the agent's own history says what it asked and what it was told.
 */
export function messageTextWithPlacedParts(message: Message): string {
	const text = message.parts
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "collaboration") return describeCollaboration(part);
			if (part.type === "file") return describeAttachment(part, { usesSandbox: false });
			return describeToolCall(part);
		})
		.join("\n\n")
		.trim();
	return text && message.replyTo ? `${describeReplyTo(message.replyTo)}\n${text}` : text;
}

/** The line a reply starts with, naming the message it quotes. */
export function describeReplyTo(replyTo: MessageReplyTo): string {
	return `[Replying to ${messageAuthorName(replyTo.author)}: "${replyTo.preview}"]`;
}

/**
 * A tool call as one bracketed line. The full output stays on its row: a
 * fetched page replayed in every later turn would fill the context with pages
 * the agent has already read. `resultFile` is the thread file the result was
 * kept as when it was too long to give whole, which the agent can read on.
 */
export function describeToolCall(call: ToolCallPart, resultFile?: string): string {
	const asked = `[Used ${call.tool} with ${clipped(JSON.stringify(call.input), DESCRIBED_INPUT_CHARACTERS)}`;
	switch (call.status) {
		case "awaiting_approval":
			return `${asked}; waiting for approval]`;
		case "running":
			return `${asked}; no result was recorded]`;
		case "failed":
			return `${asked}; it failed: ${call.error ?? "no reason given"}]`;
		case "completed":
			if (call.tool === TOOL_SEARCH) return `${asked}: found ${foundToolNames(call.output)}]`;
			return `${asked}: ${clipped(
				JSON.stringify(call.output),
				call.tool === SEARCH_HISTORY_TOOL
					? DESCRIBED_HISTORY_SEARCH_CHARACTERS
					: DESCRIBED_OUTPUT_CHARACTERS,
			)}${resultFile ? `; the result is kept as file ${resultFile}, which ${READ_THREAD_FILE_TOOL} reads` : ""}]`;
	}
}

/**
 * A file attached to a message as one bracketed line: the agent is given what
 * it is and how to read it, not its content, which may be large or not text.
 * An agent that `usesSandbox` is also told it can copy the file into the
 * sandbox. That depends on the agent, not on whether its sandbox is up, so
 * the line stays the same in the history its later requests repeat.
 */
export function describeAttachment(
	file: FilePart,
	{ usesSandbox }: { usesSandbox: boolean },
): string {
	const reads = usesSandbox
		? `which ${READ_THREAD_FILE_TOOL} reads, or ${COPY_FILE_TO_SANDBOX_TOOL} copies`
		: `which ${READ_THREAD_FILE_TOOL} reads`;
	return `[Attached ${file.name} (${file.contentType}, ${sizeOf(file.size)}) as file ${file.id}, ${reads}]`;
}

/**
 * A file attached to a message in another thread, as one bracketed line. The
 * thread tools read only the agent's own thread's files, so it is told what
 * the file is and not how to read it.
 */
export function describeAttachmentElsewhere(file: FilePart): string {
	return `[Attached ${file.name} (${file.contentType}, ${sizeOf(file.size)}), which can be read only in its own thread]`;
}

/** A file's size as people write it, such as 2.1 MB. */
function sizeOf(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FoundToolNames = Schema.Struct({
	tools: Schema.Array(Schema.Struct({ tool: Schema.String })),
});

/** foundToolNames leaves out schemas: a later turn that needs one searches again. */
function foundToolNames(output: unknown): string {
	const found = Option.match(Schema.decodeUnknownOption(FoundToolNames)(output), {
		onNone: () => [],
		onSome: ({ tools }) => tools.map(({ tool }) => tool),
	});
	return found.length > 0 ? found.join(", ") : "no tools";
}

function clipped(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} characters)`;
}

export function describeCollaboration(collaboration: CollaborationPart): string {
	const asked = `[Platform collaboration record: asked ${collaboration.agentName}: ${collaboration.brief}]`;
	switch (collaboration.status) {
		case "waiting":
		case "pending":
			return `${asked}\n[Platform collaboration record: ${collaboration.agentName} has not answered yet]`;
		case "answered":
			return `${asked}\n[Platform collaboration record: ${collaboration.agentName} answered: ${collaboration.answer ?? ""}]`;
		case "failed":
			return `${asked}\n[Platform collaboration record: ${collaboration.agentName} could not answer]`;
	}
}

/**
 * A point in a thread's history, with the day as well as the time since long
 * threads span days: "Fri, 15 May 2026, 17:40 UTC".
 */
export function formatHistoryTime(at: Date): string {
	return `${historyTime.format(at)} UTC`;
}

const historyTime = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	day: "numeric",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

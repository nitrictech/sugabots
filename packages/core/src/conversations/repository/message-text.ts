import {
	type CollaborationPart,
	type FilePart,
	type Message,
	type MessageReplyTo,
	messageAuthorName,
	type ToolCallPart,
	type WrittenFilePart,
} from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { COPY_FILE_TO_COMPUTER_TOOL } from "../tools/computer/tools.ts";
import { FILE_READ_TOOL } from "../tools/files/tool.ts";
import { READ_CONVERSATION_FILE_TOOL } from "../tools/read-conversation-file/tool.ts";
import { TOOL_SEARCH } from "../tools/tool-search/tool.ts";

/** The tool a bot searches its conversation's older history with. */
export const SEARCH_HISTORY_TOOL = "search_history";

/** How much of a tool call's input and output the bot's history keeps. */
const DESCRIBED_INPUT_CHARACTERS = 200;
const DESCRIBED_OUTPUT_CHARACTERS = 500;
/**
 * What `search_history` found is kept longer: it is the older history the
 * bot went looking for, and clipped to a few hundred characters it would
 * have to search again on its next turn.
 */
const DESCRIBED_HISTORY_SEARCH_CHARACTERS = 4_000;

/**
 * A message as prose, with each collaboration and tool call written where it
 * happened so the bot's own history says what it asked and what it was told.
 */
export function messageTextWithPlacedParts(message: Message): string {
	const text = message.parts
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "collaboration") return describeCollaboration(part);
			if (part.type === "file") return describeAttachment(part, { usesComputer: false });
			if (part.type === "written_file") return describeWrittenFile(part);
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
 * the bot has already read. `resultFile` is the conversation's file the result was
 * kept as when it was too long to give whole, which the bot can read on.
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
			)}${resultFile ? `; the result is kept as file ${resultFile}, which ${READ_CONVERSATION_FILE_TOOL} reads` : ""}]`;
	}
}

/**
 * A file attached to a message as one bracketed line: the bot is given what
 * it is and how to read it, not its content, which may be large or not text.
 * A bot that `usesComputer` is also told it can copy the file into the
 * computer. That depends on the bot, not on whether its computer is up, so
 * the line stays the same in the history its later requests repeat.
 */
export function describeAttachment(
	file: FilePart,
	{ usesComputer }: { usesComputer: boolean },
): string {
	const reads = usesComputer
		? `which ${READ_CONVERSATION_FILE_TOOL} reads, or ${COPY_FILE_TO_COMPUTER_TOOL} copies`
		: `which ${READ_CONVERSATION_FILE_TOOL} reads`;
	return `[Attached ${file.name} (${file.contentType}, ${sizeOf(file.size)}) as file ${file.id}, ${reads}]`;
}

/**
 * A file an automation run's posted result shows, as one bracketed line: the
 * file itself is kept apart from the message, where it may have changed since.
 */
export function describeWrittenFile(file: WrittenFilePart): string {
	return `[Showed the ${file.kind} file "${file.title}" as written at version ${file.version}, file ${file.fileId}; ${FILE_READ_TOOL} reads its current version]`;
}

/**
 * A file attached to a message in another conversation, as one bracketed line. The
 * conversation tools read only the bot's own conversation's files, so it is told what
 * the file is and not how to read it.
 */
export function describeAttachmentElsewhere(file: FilePart): string {
	return `[Attached ${file.name} (${file.contentType}, ${sizeOf(file.size)}), which can be read only in its own conversation]`;
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
	const asked = `[Platform collaboration record: asked ${collaboration.botName}: ${collaboration.brief}]`;
	switch (collaboration.status) {
		case "waiting":
		case "pending":
			return `${asked}\n[Platform collaboration record: ${collaboration.botName} has not answered yet]`;
		case "answered":
			return `${asked}\n[Platform collaboration record: ${collaboration.botName} answered: ${collaboration.answer ?? ""}]`;
		case "failed":
			return `${asked}\n[Platform collaboration record: ${collaboration.botName} could not answer]`;
	}
}

/**
 * A point in a conversation's history, with the day as well as the time since long
 * conversations span days: "Fri, 15 May 2026, 17:40 UTC".
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

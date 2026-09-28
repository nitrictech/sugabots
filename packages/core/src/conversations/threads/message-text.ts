import type { CollaborationPart, Message, ToolCallPart } from "@sugabots/contracts";
import { SEARCH_HISTORY_TOOL } from "../tools/search-history/tool.ts";

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
	return message.parts
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "collaboration") return describeCollaboration(part);
			return describeToolCall(part);
		})
		.join("\n\n")
		.trim();
}

/**
 * A tool call as one bracketed line. The full output stays on its row: a
 * fetched page replayed in every later turn would fill the context with pages
 * the agent has already read.
 */
export function describeToolCall(call: ToolCallPart): string {
	const asked = `[Used ${call.tool} with ${clipped(JSON.stringify(call.input), DESCRIBED_INPUT_CHARACTERS)}`;
	switch (call.status) {
		case "awaiting_approval":
			return `${asked}; waiting for approval]`;
		case "running":
			return `${asked}; no result was recorded]`;
		case "failed":
			return `${asked}; it failed: ${call.error ?? "no reason given"}]`;
		case "completed":
			return `${asked}: ${clipped(
				JSON.stringify(call.output),
				call.tool === SEARCH_HISTORY_TOOL
					? DESCRIBED_HISTORY_SEARCH_CHARACTERS
					: DESCRIBED_OUTPUT_CHARACTERS,
			)}]`;
	}
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

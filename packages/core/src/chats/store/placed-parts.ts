import type { FilePart, ToolCallPart } from "@sugabots/contracts";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { loadFileParts } from "./file-parts.ts";
import { loadToolCallParts } from "./tool-calls.ts";

/**
 * The parts a message keeps by reference, loaded from their own tables so
 * `toMessage` can put them back where the reply's text placed them, and the
 * files attached to it, which follow its text.
 */
export interface PlacedPartsOf {
	toolCalls?: readonly ToolCallPart[];
	files?: readonly FilePart[];
}

/** The referenced parts of each of these messages, as a lookup by message id. */
export const loadPlacedParts = Effect.fn("PlacedParts.loadPlacedParts")(function* (
	db: Executor,
	messageIds: readonly string[],
) {
	const toolCalls = yield* loadToolCallParts(db, messageIds);
	const files = yield* loadFileParts(db, messageIds);
	return (messageId: string): PlacedPartsOf => ({
		toolCalls: toolCalls.get(messageId),
		files: files.get(messageId),
	});
});

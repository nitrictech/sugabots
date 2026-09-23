import type { CollaborationPart, ToolCallPart } from "@sugabots/contracts";
import type { Executor } from "../../database/database.ts";
import { loadCollaborationParts } from "./collaborations.ts";
import { loadToolCallParts } from "./tool-calls.ts";

/**
 * The parts a message keeps by reference, loaded from their own tables so
 * `toMessage` can put them back where the reply's text placed them.
 */
export interface PlacedPartsOf {
	collaborations?: readonly CollaborationPart[];
	toolCalls?: readonly ToolCallPart[];
}

/** The referenced parts of each of these messages, as a lookup by message id. */
export async function loadPlacedParts(
	db: Executor,
	messageIds: readonly string[],
): Promise<(messageId: string) => PlacedPartsOf> {
	const collaborations = await loadCollaborationParts(db, messageIds);
	const toolCalls = await loadToolCallParts(db, messageIds);
	return (messageId) => ({
		collaborations: collaborations.get(messageId),
		toolCalls: toolCalls.get(messageId),
	});
}

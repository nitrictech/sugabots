import type { CollaborationPart } from "@sugabots/contracts";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { agent, collaboration } from "../../database/schema.ts";
import type { CollaborationChange } from "../events.ts";

/**
 * Reading collaborations back into the messages they belong to.
 *
 * A message stores a collaboration by id only (`StoredMessagePart`); the status and
 * answer live on the `collaboration` row, which the collaborator's turn updates without
 * touching the reply. These two functions put the row back into the part the
 * API hands out. Writing collaborations is `tools/collaborate/store.ts`.
 */

/** The collaborations made in each of these messages, keyed by message id. */
export const loadCollaborationParts = Effect.fn("Collaborations.loadCollaborationParts")(function* (
	db: Executor,
	messageIds: readonly string[],
) {
	const byMessage = new Map<string, CollaborationPart[]>();
	if (messageIds.length === 0) {
		return byMessage;
	}
	const rows = yield* db
		.select({ collaboration, collaboratorName: agent.name })
		.from(collaboration)
		.innerJoin(agent, eq(agent.id, collaboration.collaboratorAgentId))
		.where(inArray(collaboration.parentMessageId, [...messageIds]));
	for (const row of rows) {
		const parts = byMessage.get(row.collaboration.parentMessageId) ?? [];
		parts.push(toCollaborationPart(row.collaboration, row.collaboratorName));
		byMessage.set(row.collaboration.parentMessageId, parts);
	}
	return byMessage;
});

export function toCollaborationPart(
	row: schema.CollaborationRow,
	collaboratorName: string,
): CollaborationPart {
	return {
		type: "collaboration",
		id: row.id,
		agentId: row.collaboratorAgentId,
		agentName: collaboratorName,
		threadId: row.childThreadId,
		brief: row.brief,
		status: row.status,
		answer: row.answer,
		atOffset: row.atOffset,
	};
}

/** The collaboration as an event carries it once it has changed. */
export function collaborationChange(
	row: schema.CollaborationRow,
	collaboratorName: string,
): CollaborationChange {
	return {
		parentThreadId: row.parentThreadId,
		parentMessageId: row.parentMessageId,
		collaboration: toCollaborationPart(row, collaboratorName),
	};
}

import type { CollaborationPart } from "@sugabots/contracts";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { bot, collaboration } from "../../database/schema.ts";

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
		.select({ collaboration, collaboratorName: bot.name })
		.from(collaboration)
		.innerJoin(bot, eq(bot.id, collaboration.collaboratorBotId))
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
		botId: row.collaboratorBotId,
		botName: collaboratorName,
		chatId: row.chatId,
		brief: row.brief,
		status: row.status,
		answer: row.answer,
		atOffset: row.atOffset,
	};
}

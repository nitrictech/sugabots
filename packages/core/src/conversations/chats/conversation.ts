import type { Conversation } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/** A conversation's thread as the API describes it. */
export function toConversation(row: schema.ThreadRow): Conversation {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		hostAgentId: row.hostAgentId,
		title: row.title,
		doneAt: row.doneAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

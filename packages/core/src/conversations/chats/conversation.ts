import type { AutomationFeed, DirectMessage, ProjectThread } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/**
 * A project's thread, one of a bot's threads included, as the API describes
 * it. Throws on a conversation of another kind.
 */
export function toProjectThread(row: schema.PlacedConversationRow): ProjectThread {
	if (row.kind !== "project_thread" || !row.projectId)
		throw new Error(`Conversation ${row.id} is not in a project`);
	return {
		kind: "project_thread",
		...commonFields(row),
		projectId: row.projectId,
		botId: row.botId,
		archivedAt: row.archivedAt?.toISOString() ?? null,
		doneAt: row.doneAt?.toISOString() ?? null,
	};
}

/** An automation's feed as the API describes it. Throws on a conversation of another kind. */
export function toAutomationFeed(row: schema.PlacedConversationRow): AutomationFeed {
	if (row.kind !== "automation_feed" || !row.automationId || !row.projectId) {
		throw new Error(`Conversation ${row.id} is not an automation's feed`);
	}
	return {
		kind: "automation_feed",
		...commonFields(row),
		projectId: row.projectId,
		botId: row.botId,
		automationId: row.automationId,
	};
}

/** A direct message between people as the API describes it. Throws on a conversation of another kind. */
export function toDirectMessage(row: schema.PlacedConversationRow): DirectMessage {
	if (row.kind !== "direct_message") {
		throw new Error(`Conversation ${row.id} is not a direct message`);
	}
	return { kind: "direct_message", ...commonFields(row) };
}

function commonFields(row: schema.PlacedConversationRow) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		title: row.title,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

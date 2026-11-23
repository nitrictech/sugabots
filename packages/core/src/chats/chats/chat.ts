import type { AutomationFeed, ProjectChat } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/**
 * A project's chat, one of a bot's chats included, as the API describes
 * it. Throws on a chat of another kind.
 */
export function toProjectChat(row: schema.PlacedChatRow): ProjectChat {
	if (row.kind !== "project_chat" || !row.projectId)
		throw new Error(`Chat ${row.id} is not in a project`);
	return {
		kind: "project_chat",
		...commonFields(row),
		projectId: row.projectId,
		botId: row.botId,
		resolvedAt: row.resolvedAt?.toISOString() ?? null,
	};
}

/** An automation's feed as the API describes it. Throws on a chat of another kind. */
export function toAutomationFeed(row: schema.PlacedChatRow): AutomationFeed {
	if (row.kind !== "automation_feed" || !row.automationId || !row.projectId) {
		throw new Error(`Chat ${row.id} is not an automation's feed`);
	}
	return {
		kind: "automation_feed",
		...commonFields(row),
		projectId: row.projectId,
		botId: row.botId,
		automationId: row.automationId,
	};
}

function commonFields(row: schema.PlacedChatRow) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		title: row.title,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

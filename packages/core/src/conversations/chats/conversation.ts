import type { AutomationFeed, ChannelConversation, DirectMessage, Task } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/** A channel's main chat or thread as the API describes it. Throws on a conversation of another kind. */
export function toChannelConversation(row: schema.PlacedConversationRow): ChannelConversation {
	if (row.kind !== "channel_conversation" || !row.channelId)
		throw new Error(`Conversation ${row.id} is not in a channel`);
	return {
		kind: "channel_conversation",
		...commonFields(row),
		channelId: row.channelId,
		main: row.main,
		archivedAt: row.archivedAt?.toISOString() ?? null,
	};
}

/** A bot's task as the API describes it. Throws on a conversation of another kind. */
export function toTask(row: schema.PlacedConversationRow): Task {
	if (row.kind !== "task" || !row.botId) {
		throw new Error(`Conversation ${row.id} is not a task`);
	}
	return {
		kind: "task",
		...commonFields(row),
		botId: row.botId,
		doneAt: row.doneAt?.toISOString() ?? null,
	};
}

/** An automation's feed as the API describes it. Throws on a conversation of another kind. */
export function toAutomationFeed(row: schema.PlacedConversationRow): AutomationFeed {
	if (row.kind !== "automation_feed" || !row.automationId || !row.botId) {
		throw new Error(`Conversation ${row.id} is not an automation's feed`);
	}
	return {
		kind: "automation_feed",
		...commonFields(row),
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

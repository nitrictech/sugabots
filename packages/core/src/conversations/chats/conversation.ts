import type { ConversationThread, Direct, PodChat, RoutineFeed } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/** A channel's main chat or thread as the API describes it. Throws on a thread of another type. */
export function toPodChat(row: schema.ThreadRow): PodChat {
	if (row.type !== "pod_chat" || !row.podId)
		throw new Error(`Thread ${row.id} is not in a channel`);
	return {
		kind: "pod_chat",
		...commonFields(row),
		podId: row.podId,
		main: row.main,
		archivedAt: row.archivedAt?.toISOString() ?? null,
	};
}

/** A bot's task as the API describes it. Throws on a thread of another type. */
export function toConversationThread(row: schema.ThreadRow): ConversationThread {
	if (row.type !== "conversation" || !row.hostAgentId) {
		throw new Error(`Thread ${row.id} is not a task`);
	}
	return {
		kind: "thread",
		...commonFields(row),
		hostAgentId: row.hostAgentId,
		doneAt: row.doneAt?.toISOString() ?? null,
	};
}

/** An automation's own thread as the API describes it. Throws on a thread of another type. */
export function toRoutineFeed(row: schema.ThreadRow): RoutineFeed {
	if (row.type !== "routine_feed" || !row.routineId || !row.hostAgentId) {
		throw new Error(`Thread ${row.id} is not an automation's thread`);
	}
	return {
		kind: "routine_feed",
		...commonFields(row),
		hostAgentId: row.hostAgentId,
		routineId: row.routineId,
	};
}

/** A direct message between people as the API describes it. Throws on a thread of another type. */
export function toDirect(row: schema.ThreadRow): Direct {
	if (row.type !== "direct") throw new Error(`Thread ${row.id} is not a direct message`);
	return { kind: "direct", ...commonFields(row) };
}

function commonFields(row: schema.ThreadRow) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		title: row.title,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

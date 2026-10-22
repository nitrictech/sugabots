import type { ConversationThread, PodChat, RoutineFeed } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/** A pod's chat as the API describes it. Throws on a thread of another type. */
export function toPodChat(row: schema.ThreadRow): PodChat {
	if (row.type !== "pod_chat") throw new Error(`Thread ${row.id} is not a pod's chat`);
	return {
		kind: "pod_chat",
		...commonFields(row),
		main: row.main,
		archivedAt: row.archivedAt?.toISOString() ?? null,
	};
}

/** A thread with a bot or between people as the API describes it. Throws on a thread of another type. */
export function toConversationThread(row: schema.ThreadRow): ConversationThread {
	if (row.type !== "conversation") throw new Error(`Thread ${row.id} is not a conversation`);
	return {
		kind: "thread",
		...commonFields(row),
		hostAgentId: row.hostAgentId,
		doneAt: row.doneAt?.toISOString() ?? null,
	};
}

/** A routine's own thread as the API describes it. Throws on a thread of another type. */
export function toRoutineFeed(row: schema.ThreadRow): RoutineFeed {
	if (row.type !== "routine_feed" || !row.routineId || !row.hostAgentId) {
		throw new Error(`Thread ${row.id} is not a routine's thread`);
	}
	return {
		kind: "routine_feed",
		...commonFields(row),
		hostAgentId: row.hostAgentId,
		routineId: row.routineId,
	};
}

function commonFields(row: schema.ThreadRow) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		title: row.title,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

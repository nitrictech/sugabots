import type {
	BotChannel,
	ConversationThread,
	Direct,
	PodChat,
	RoutineFeed,
} from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";
import { threadPodId } from "../threads/rooms.ts";

/** A pod's chat as the API describes it. Throws on a thread of another type. */
export function toPodChat(row: schema.ThreadRow): PodChat {
	if (row.type !== "pod_chat") throw new Error(`Thread ${row.id} is not a pod's chat`);
	return {
		kind: "pod_chat",
		...inPodFields(row),
		main: row.main,
		archivedAt: row.archivedAt?.toISOString() ?? null,
	};
}

/** A bot's channel as the API describes it. Throws on a thread of another type. */
export function toBotChannel(row: schema.ThreadRow): BotChannel {
	if (row.type !== "bot_channel" || !row.hostAgentId) {
		throw new Error(`Thread ${row.id} is not a bot's channel`);
	}
	return { kind: "bot_channel", ...inPodFields(row), hostAgentId: row.hostAgentId };
}

/** A thread with a bot or between people as the API describes it. Throws on a thread of another type. */
export function toConversationThread(row: schema.ThreadRow): ConversationThread {
	if (row.type !== "conversation") throw new Error(`Thread ${row.id} is not a conversation`);
	return {
		kind: "thread",
		...inPodFields(row),
		hostAgentId: row.hostAgentId,
		startedInChatId: row.parentThreadId,
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
		...inPodFields(row),
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

/** What a conversation in a pod has: every kind but a direct message. */
function inPodFields(row: schema.ThreadRow) {
	return { ...commonFields(row), podId: threadPodId(row.id, row.podId) };
}

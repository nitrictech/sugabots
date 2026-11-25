import type { ChatMessageItem, Message } from "@sugabots/contracts";
import { chatItemCreatedAt } from "@/lib/chats.ts";
import { startsNewDay } from "./chat-layout.ts";

/** An automation's run, or its pausing itself, which a chat draws as a row of its own. */
type AutomationItem = Extract<ChatMessageItem, { kind: "run" | "automation_paused" }>;

/** A stretch of a chat as it is drawn; see `chatGroupsOf`. */
type ChatGroup = { key: string; at: string; separated: boolean } & (
	| { kind: "messages"; messages: Message[] }
	| { kind: "run"; item: AutomationItem }
);

/**
 * A chat's items in the order they happened: the pages loaded, those sent
 * from here and not yet heard back, and those the chat's live state
 * holds, each once.
 */
export function mergeChatItems(
	pageItems: readonly ChatMessageItem[],
	optimistic: readonly ChatMessageItem[],
	liveMessages: readonly Message[],
): ChatMessageItem[] {
	const items = new Map<string, ChatMessageItem>();
	for (const item of pageItems) {
		items.set(chatItemId(item), item);
	}
	for (const message of liveMessages)
		items.set(`message:${message.id}`, { kind: "message", message });
	const saved = new Set(messagesIn([...items.values()]).map(messageKey));
	for (const item of optimistic) {
		if (item.kind === "message" && !saved.has(messageKey(item.message))) {
			items.set(chatItemId(item), item);
		}
	}
	return [...items.values()].sort((left, right) =>
		chatItemCreatedAt(left).localeCompare(chatItemCreatedAt(right)),
	);
}

/** The messages shown as sent that the API has not yet been heard to have. */
export function sendingIds(
	optimistic: readonly ChatMessageItem[],
	pageItems: readonly ChatMessageItem[],
	liveMessages: readonly Message[],
): ReadonlySet<string> {
	const saved = new Set([
		...messagesIn(pageItems).map(messageKey),
		...liveMessages.map(messageKey),
	]);
	return new Set(
		optimistic.flatMap((item) =>
			item.kind === "message" && !saved.has(messageKey(item.message)) ? [item.message.id] : [],
		),
	);
}

function messageKey(message: Message): string {
	return message.retryKey && message.author.kind === "member"
		? `retry:${message.author.id}:${message.retryKey}`
		: message.id;
}

/** The messages among `items`, leaving out automation runs and pauses. */
export function messagesIn(items: readonly ChatMessageItem[]): Message[] {
	return items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
}

function chatItemId(item: ChatMessageItem): string {
	return item.kind === "message" ? `message:${item.message.id}` : `${item.kind}:${item.id}`;
}

/** What changes whenever `item`, the newest, does: a new item, or the same message streamed further. */
export function chatItemRevision(item: ChatMessageItem | undefined): string {
	if (!item) return "";
	if (item.kind !== "message") return `${item.kind}:${item.id}`;
	return `${item.message.id}:${item.message.status}:${item.message.content}:${JSON.stringify(item.message.parts)}`;
}

/**
 * The chat's items as they are drawn: messages together, so one author's
 * messages in a row read as a run of them, and each automation's run or pause
 * on its own. A new day starts a new group behind a separator.
 */
export function chatGroupsOf(items: readonly ChatMessageItem[], byRun: boolean): ChatGroup[] {
	const groups: ChatGroup[] = [];
	let previousAt: string | undefined;
	for (const item of items) {
		const at = item.kind === "message" ? item.message.createdAt : item.createdAt;
		// An automation's feed is marked where each run starts; any other, where each day does.
		const separated = byRun ? startsAutomationRun(item) : startsNewDay(previousAt, at);
		previousAt = at;
		const last = groups.at(-1);
		if (item.kind === "message") {
			if (last?.kind === "messages" && !separated) {
				last.messages.push(item.message);
				continue;
			}
			groups.push({
				kind: "messages",
				key: item.message.id,
				at,
				separated,
				messages: [item.message],
			});
			continue;
		}
		groups.push({ kind: "run", key: item.id, at, separated, item });
	}
	return groups;
}

/** Whether `item` is where a run starts in an automation's feed: its result, or the run itself when it posted none. */
function startsAutomationRun(item: ChatMessageItem): boolean {
	return item.kind === "run" || (item.kind === "message" && !!item.message.automationResultOf);
}

/** The newest automation run in `items`, which is the one that can be tried again. */
export function latestRunId(items: readonly ChatMessageItem[]): string | undefined {
	return items.findLast((item) => item.kind === "run")?.id;
}

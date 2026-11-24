export * as Audience from "./audience.ts";

import type { StreamEvent } from "@sugabots/contracts";

/**
 * Who may hear an event on a workspace's stream. Everyone in the
 * workspace listens there, but an event about a chat is only for the
 * members who reach it: a project's chat by those in the project, and a
 * bot's by those who reach the bot.
 *
 * The chat rides along in the stored event, under the field below; the
 * stream reads it and takes it off before delivering.
 */
export type Group = { readonly chatId: string };

const CHAT_FIELD = "audienceChatId";

/** `event`, to be heard only by members who reach the chat `chatId`. */
export const forChat = <Event extends StreamEvent>(chatId: string, event: Event): Event => ({
	...event,
	[CHAT_FIELD]: chatId,
});

/**
 * Who alone may hear `event`, if it names anybody, and the event as clients
 * see it, without the field that says so.
 */
export function read(event: StreamEvent): {
	readonly audience: Group | undefined;
	readonly event: StreamEvent;
} {
	const { [CHAT_FIELD]: chatId, ...delivered }: StreamEvent = event;
	const audience: Group | undefined = typeof chatId === "string" ? { chatId } : undefined;
	return { audience, event: delivered as StreamEvent };
}

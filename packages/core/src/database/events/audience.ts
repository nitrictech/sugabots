export * as Audience from "./audience.ts";

import type { StreamEvent } from "@sugabots/contracts";

/**
 * Who may hear an event on a workspace's stream. Every member of the
 * workspace listens there, but an event about a conversation is only for the
 * people who reach it: a project's thread by those in the project, a
 * bot's by those who reach the bot, and a direct message by those in it.
 * Which rides along in the stored event, under the field below, and the
 * stream reads it and takes it off before delivering.
 */
export type Group = { readonly kind: "conversation"; readonly conversationId: string };

const CONVERSATION_FIELD = "audienceConversationId";

/** `event`, to be heard only by people who reach the conversation `conversationId`. */
export const forConversation = <Event extends StreamEvent>(
	conversationId: string,
	event: Event,
): Event => ({
	...event,
	[CONVERSATION_FIELD]: conversationId,
});

/**
 * Who alone may hear `event`, if it names anybody, and the event as clients
 * see it, without the field that says so.
 */
export function read(event: StreamEvent): {
	readonly audience: Group | undefined;
	readonly event: StreamEvent;
} {
	const { [CONVERSATION_FIELD]: conversationId, ...delivered }: StreamEvent = event;
	const audience: Group | undefined =
		typeof conversationId === "string" ? { kind: "conversation", conversationId } : undefined;
	return { audience, event: delivered as StreamEvent };
}

export * as Audience from "./audience.ts";

import type { StreamEvent } from "@sugabots/contracts";

/**
 * Who may hear an event on a workspace channel. Every member of the
 * workspace listens there, but an event about a conversation is only for the
 * people who reach it: a channel's conversation by those in the channel, a
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
 * Who heard the events stored before an event named its conversation, by the fields
 * they were stored with: everyone in a group of people and bots, or in a
 * direct message. Nothing can tell who those are any more, so such an event,
 * replayed to a client that reconnects, is heard by nobody.
 */
interface LegacyAudience {
	readonly audiencePodId?: unknown;
	readonly audienceDirectId?: unknown;
}

/** An event nobody may hear. */
export type Nobody = { readonly kind: "nobody" };

/**
 * Who alone may hear `event`, if it names anybody, and the event as clients
 * see it, without the fields that say so.
 */
export function read(event: StreamEvent): {
	readonly audience: Group | Nobody | undefined;
	readonly event: StreamEvent;
} {
	const {
		[CONVERSATION_FIELD]: conversationId,
		audiencePodId,
		audienceDirectId,
		...delivered
	}: StreamEvent & LegacyAudience = event;
	const audience: Group | Nobody | undefined =
		audiencePodId !== undefined || audienceDirectId !== undefined
			? { kind: "nobody" }
			: typeof conversationId === "string"
				? { kind: "conversation", conversationId }
				: undefined;
	return { audience, event: delivered as StreamEvent };
}

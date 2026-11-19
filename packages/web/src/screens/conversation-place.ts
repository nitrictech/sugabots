import type { useAnyConversationPlace } from "@/lib/chats.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";

/** Where any conversation is: one of a project's threads, one of a bot's, or a direct message. */
export type AnyConversationPlace = NonNullable<ReturnType<typeof useAnyConversationPlace>["found"]>;

/**
 * Whose a conversation is, as their pages show it: a bot's thread is its bot's,
 * a project's thread its project's. A direct message is nobody's.
 */
export function conversationOwner(place: AnyConversationPlace): ResourceOwner | undefined {
	if (place.project) return { project: place.project };
	if (place.conversation.kind === "botThread") return { bot: place.conversation.bot };
	return undefined;
}

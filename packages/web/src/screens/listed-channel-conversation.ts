import type { Channel } from "@sugabots/contracts";
import { useChatList } from "@/lib/chats.ts";
import type { ChannelConversationToChange } from "./ChatMenu.tsx";

/**
 * A channel's main chat or thread as its channel lists it: what it is called,
 * and, for whoever may change the channel, how to rename or archive it from
 * its menu or its details. An archived thread is not listed, so it goes by
 * `title`, the name it was archived with.
 */
export function useListedChannelConversation(
	channel: Channel | null,
	conversationId: string,
	title: string | undefined,
): { name: string; toChange: ChannelConversationToChange | undefined } {
	const chats = useChatList(channel?.slug).data?.chats;
	const listed = chats?.find((chat) => chat.conversation.id === conversationId)?.conversation;
	const name = listed?.title ?? title ?? "";
	const toChange =
		listed && channel?.permissions.rename
			? { channel, conversationId, name, archivable: !listed.main }
			: undefined;
	return { name, toChange };
}

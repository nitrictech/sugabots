import type { ReactNode } from "react";
import {
	type ChatLocation,
	placeBot,
	useChatHistory,
	useMarkNestedChatReadWhileSeen,
} from "@/lib/chats.ts";
import type { BackTo } from "./ChatHeader.tsx";
import { NestedChatPanel } from "./NestedChatPanel.tsx";

/**
 * A run or collaboration in a chat, a bot's or a project's, as a page of
 * its own, read while it is seen, with `back` before its name.
 */
export function NestedChatPage({
	chatLocation,
	chatId,
	nestedChatId,
	back,
	trailing,
	onOpenNestedChat,
}: {
	/** Where the nested chat's root chat is. */
	chatLocation: ChatLocation;
	chatId: string;
	nestedChatId: string;
	back: BackTo;
	trailing: ReactNode;
	onOpenNestedChat: (nestedChatId: string) => void;
}) {
	const history = useChatHistory(chatId);
	useMarkNestedChatReadWhileSeen(nestedChatId);
	return (
		<NestedChatPanel
			frame={{ kind: "page", back, trailing }}
			chatId={chatId}
			chatBotId={placeBot(chatLocation)?.id}
			owner={chatLocation}
			nestedChatId={nestedChatId}
			entry={history.entries.find((entry) => entry.chatId === nestedChatId)}
			history={history.entries}
			onOpenNestedChat={onOpenNestedChat}
		/>
	);
}

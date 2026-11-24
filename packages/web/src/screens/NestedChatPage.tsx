import type { ReactNode } from "react";
import { type ChatLocation, useChatHistory, useMarkNestedChatReadWhileSeen } from "@/lib/chats.ts";
import type { BackTo } from "./ChatHeader.tsx";
import { NestedChatPanel } from "./NestedChatPanel.tsx";

/**
 * An automation's run in a chat, a bot's or a project's, as a page of its
 * own, read while it is seen, with `back` before its name.
 */
export function NestedChatPage({
	chatLocation,
	chatId,
	nestedChatId,
	back,
	trailing,
}: {
	/** Where the nested chat's root chat is. */
	chatLocation: ChatLocation;
	chatId: string;
	nestedChatId: string;
	back: BackTo;
	trailing: ReactNode;
}) {
	const history = useChatHistory(chatId);
	useMarkNestedChatReadWhileSeen(nestedChatId);
	return (
		<NestedChatPanel
			back={back}
			trailing={trailing}
			chatId={chatId}
			owner={chatLocation}
			nestedChatId={nestedChatId}
			entry={history.entries.find((entry) => entry.chatId === nestedChatId)}
		/>
	);
}

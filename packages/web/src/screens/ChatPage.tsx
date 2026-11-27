import { botColorVariables } from "@sugabots/avatars";
import type { ComponentProps } from "react";
import { placeBot } from "@/lib/chats.ts";
import { useDetailsOpen } from "@/lib/details-open.ts";
import { usePresence } from "@/lib/notifications.ts";
import { ChatPane } from "./ChatPane.tsx";

type ChatPageProps = Omit<ComponentProps<typeof ChatPane>, "place">;

export function ChatPage(chat: ChatPageProps) {
	usePresence(chat.chatId);
	const bot = placeBot(chat.chatLocation);
	return (
		<div
			className="relative flex min-h-0 flex-1 overflow-hidden"
			style={bot ? botColorVariables(bot.color) : undefined}
		>
			<OwnPageChat {...chat} />
		</div>
	);
}

/**
 * The chat on its own page, with Details open or closed as this device last
 * left them. Details stay as they are from one chat to the next.
 */
function OwnPageChat(chat: ChatPageProps) {
	const [detailsOpen, setDetailsOpen] = useDetailsOpen();
	return (
		<ChatPane
			key={chat.chatId}
			{...chat}
			place={{ kind: "own", detailsOpen, onDetailsChange: setDetailsOpen }}
		/>
	);
}

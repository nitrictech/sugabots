import { botColorVariables } from "@sugabots/avatars";
import type { ComponentProps, ReactNode } from "react";
import { placeBot } from "@/lib/chats.ts";
import { useDetailsOpen } from "@/lib/details-open.ts";
import { usePresence } from "@/lib/notifications.ts";
import type { BackTo } from "./ChatHeader.tsx";
import { ConversationChat } from "./ConversationChat.tsx";

type ConversationPageProps = Omit<ComponentProps<typeof ConversationChat>, "place"> & {
	/**
	 * Shown away from the chat's own page, as Inbox shows it: no Details,
	 * and the header's Back and right-hand link in their places.
	 */
	away?: { back: BackTo; trailing: ReactNode };
};

export function ConversationPage({ away, ...chat }: ConversationPageProps) {
	usePresence(chat.covered ? undefined : chat.conversationId);
	const bot = placeBot(chat.conversationPlace);
	return (
		<div
			className="relative flex min-h-0 flex-1 overflow-hidden"
			style={bot ? botColorVariables(bot.color) : undefined}
		>
			{away ? (
				<ConversationChat key={chat.conversationId} {...chat} place={{ kind: "away", ...away }} />
			) : (
				<OwnPageChat {...chat} />
			)}
		</div>
	);
}

/**
 * The chat on its own page, with Details open or closed as this device last
 * left them. Details stay as they are from one chat to the next.
 */
function OwnPageChat(chat: Omit<ConversationPageProps, "away">) {
	const [detailsOpen, setDetailsOpen] = useDetailsOpen();
	return (
		<ConversationChat
			key={chat.conversationId}
			{...chat}
			place={{ kind: "own", detailsOpen, onDetailsChange: setDetailsOpen }}
		/>
	);
}

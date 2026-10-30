import { botColorVariables } from "@sugabots/avatars";
import type { Pod, SessionUser } from "@sugabots/contracts";
import type { ReactNode } from "react";
import type { ConversationKind } from "@/lib/chats.ts";
import { useDetailsOpen } from "@/lib/details-open.ts";
import { usePresence } from "@/lib/notifications.ts";
import type { BackTo } from "./ChatHeader.tsx";
import { ConversationChat, type Staged } from "./ConversationChat.tsx";

interface ConversationPageProps {
	/** Which kind of conversation it is, and its bot when it has one. */
	conversation: ConversationKind;
	pod: Pod;
	/** The conversation shown. */
	conversationId: string;
	user: SessionUser;
	threadId?: string;
	/** A message to jump to and point out, such as the mention it was opened from. */
	focusMessageId?: string;
	/**
	 * Shown away from the chat's own page, as Activity shows it: no Details,
	 * and the header's Back and right-hand link in their places.
	 */
	away?: { back: BackTo; trailing: ReactNode };
	onThreadChange: (threadId: string | undefined) => void;
	/** What is open large beside the chat. */
	staged?: Staged;
	onStagedChange: (staged: Staged | undefined) => void;
}

export function ConversationPage({ away, ...chat }: ConversationPageProps) {
	usePresence(chat.conversationId);
	return (
		<div
			className="relative flex min-h-0 flex-1 overflow-hidden"
			style={
				chat.conversation.kind === "botThread" || chat.conversation.kind === "botChannel"
					? botColorVariables(chat.conversation.agent.color)
					: undefined
			}
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

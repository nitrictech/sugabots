import { botColorVariables } from "@sugabots/avatars";
import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import type { ReactNode } from "react";
import { useDetailsOpen } from "@/lib/details-open.ts";
import type { BackTo } from "./ChatHeader.tsx";
import { ConversationChat, type Staged } from "./ConversationChat.tsx";

interface ConversationPageProps {
	/** The bot the conversation is with; null in the pod's chat. */
	agent: Agent | null;
	/** Whether it is the pod's chat, rather than a thread. */
	isPodChat: boolean;
	pod: Pod;
	/** The conversation shown, which is with `agent`. */
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
	return (
		<div
			className="relative flex min-h-0 flex-1 overflow-hidden"
			style={chat.agent ? botColorVariables(chat.agent.color) : undefined}
		>
			{away ? (
				<ConversationChat key={chatKey(chat)} {...chat} place={{ kind: "away", ...away }} />
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
			key={chatKey(chat)}
			{...chat}
			place={{ kind: "own", detailsOpen, onDetailsChange: setDetailsOpen }}
		/>
	);
}

/** Another conversation starts fresh: its scroll, its draft's audience, and what it jumped to. */
function chatKey({ conversationId }: { conversationId: string }): string {
	return conversationId;
}

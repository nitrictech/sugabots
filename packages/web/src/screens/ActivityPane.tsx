import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useChat, useChatHistory } from "@/lib/chats.ts";
import { agentChatLink } from "@/lib/links.ts";
import { AgentPage } from "./AgentPage.tsx";
import type { BackTo } from "./ChatHeader.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";

const BACK_TO_ACTIVITY: BackTo = { to: "activity" };

/**
 * What Activity shows beside its list for the item chosen: a routine run or a
 * collaboration as a page of its own, or a message in its chat, jumped to.
 * Either way it is not the chat's own page, so there is no Details, and a link
 * at the right goes to the chat itself.
 */
export function ActivityPane({
	pod,
	agent,
	user,
	threadPageId,
	focusMessageId,
	threadId,
	onThreadPageChange,
	onThreadChange,
}: {
	pod: Pod;
	agent: Agent;
	user: SessionUser;
	/** A run or collaboration shown as the page, in place of the chat. */
	threadPageId?: string;
	/** A message in the chat to jump to and point out. */
	focusMessageId?: string;
	/** A run or collaboration opened beside the chat, as on its own page. */
	threadId?: string;
	onThreadPageChange: (threadId: string) => void;
	onThreadChange: (threadId: string | undefined) => void;
}) {
	const openChat = (
		<Link
			{...agentChatLink({ pod, agent })}
			className="focus-ring shrink-0 rounded-sm font-medium text-[13px] text-link"
		>
			Open chat
		</Link>
	);
	if (threadPageId) {
		return (
			<ActivityThread
				pod={pod}
				agent={agent}
				threadId={threadPageId}
				trailing={openChat}
				onOpenThread={onThreadPageChange}
			/>
		);
	}
	return (
		<AgentPage
			agent={agent}
			pod={pod}
			user={user}
			threadId={threadId}
			focusMessageId={focusMessageId}
			away={{ back: BACK_TO_ACTIVITY, trailing: openChat }}
			onThreadChange={onThreadChange}
		/>
	);
}

/** A run or collaboration in `agent`'s chat, as a page of its own. */
function ActivityThread({
	pod,
	agent,
	threadId,
	trailing,
	onOpenThread,
}: {
	pod: Pod;
	agent: Agent;
	threadId: string;
	trailing: ReactNode;
	onOpenThread: (threadId: string) => void;
}) {
	const chat = useChat(pod, agent.id);
	const history = useChatHistory(chat.data?.id);
	if (!chat.data) return null;
	return (
		<ChatThreadPanel
			frame={{ kind: "page", back: BACK_TO_ACTIVITY, trailing }}
			chatId={chat.data.id}
			chatAgentId={agent.id}
			threadId={threadId}
			entry={history.entries.find((entry) => entry.threadId === threadId)}
			history={history.entries}
			onOpenThread={onOpenThread}
		/>
	);
}

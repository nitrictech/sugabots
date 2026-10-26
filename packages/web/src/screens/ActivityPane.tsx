import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useChatHistory } from "@/lib/chats.ts";
import { conversationLink } from "@/lib/links.ts";
import type { BackTo } from "./ChatHeader.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import type { Staged } from "./ConversationChat.tsx";
import { ConversationPage } from "./ConversationPage.tsx";

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
	conversationId,
	user,
	threadPageId,
	focusMessageId,
	threadId,
	onThreadPageChange,
	onThreadChange,
	staged,
	onStagedChange,
}: {
	pod: Pod;
	/** The bot the conversation is with; null in the pod's chat. */
	agent: Agent | null;
	/** The conversation the item is in, which is with `agent`. */
	conversationId: string;
	user: SessionUser;
	/** A run or collaboration shown as the page, in place of the chat. */
	threadPageId?: string;
	/** A message in the chat to jump to and point out. */
	focusMessageId?: string;
	/** A run or collaboration opened beside the chat, as on its own page. */
	threadId?: string;
	onThreadPageChange: (threadId: string) => void;
	onThreadChange: (threadId: string | undefined) => void;
	staged?: Staged;
	onStagedChange: (staged: Staged | undefined) => void;
}) {
	const openChat = (
		<Link
			{...conversationLink({ pod, conversationId })}
			className="focus-ring shrink-0 rounded-sm font-medium text-[13px] text-link"
		>
			Open chat
		</Link>
	);
	if (threadPageId && agent) {
		return (
			<ActivityThread
				agent={agent}
				conversationId={conversationId}
				threadId={threadPageId}
				trailing={openChat}
				onOpenThread={onThreadPageChange}
			/>
		);
	}
	return (
		<ConversationPage
			agent={agent}
			pod={pod}
			conversationId={conversationId}
			user={user}
			threadId={threadId}
			focusMessageId={focusMessageId}
			away={{ back: BACK_TO_ACTIVITY, trailing: openChat }}
			onThreadChange={onThreadChange}
			staged={staged}
			onStagedChange={onStagedChange}
		/>
	);
}

/** A run or collaboration in `agent`'s chat, as a page of its own. */
function ActivityThread({
	agent,
	conversationId,
	threadId,
	trailing,
	onOpenThread,
}: {
	agent: Agent;
	conversationId: string;
	threadId: string;
	trailing: ReactNode;
	onOpenThread: (threadId: string) => void;
}) {
	const history = useChatHistory(conversationId);
	return (
		<ChatThreadPanel
			frame={{ kind: "page", back: BACK_TO_ACTIVITY, trailing }}
			conversationId={conversationId}
			chatAgentId={agent.id}
			threadId={threadId}
			entry={history.entries.find((entry) => entry.threadId === threadId)}
			history={history.entries}
			onOpenThread={onOpenThread}
		/>
	);
}

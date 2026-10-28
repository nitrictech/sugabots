import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { type ConversationKind, useChatHistory } from "@/lib/chats.ts";
import { conversationLink, routineThreadLink } from "@/lib/links.ts";
import { useThread } from "@/lib/threads.ts";
import { buttonStyles } from "@/ui/button.tsx";
import type { BackTo } from "./ChatHeader.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import type { Staged } from "./ConversationChat.tsx";
import { ConversationPage } from "./ConversationPage.tsx";

const BACK_TO_ACTIVITY: BackTo = { to: "activity" };

/**
 * What Inbox opens for the item chosen: a routine run or a
 * collaboration as a page of its own, or a message in its chat, jumped to.
 * Either way it is not the thread's own page, so there is no Details, and Open
 * thread at the right goes to the thread itself, or, for a routine's thread,
 * to the routine on the Routines page.
 */
export function ActivityPane({
	pod,
	conversation,
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
	/** Which kind of conversation the item is in, and its bot when it has one. */
	conversation: ConversationKind;
	/** The conversation the item is in. */
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
	// A routine's own thread opens on the Routines page, beside the pod's other routines.
	const routineId = useThread(conversationId).data?.routine?.id;
	const openChat = (
		<Link
			{...(routineId
				? routineThreadLink(pod, routineId)
				: conversationLink({ pod, conversationId }))}
			className={cn(buttonStyles({ variant: "outline", size: "sm" }), "shrink-0")}
		>
			Open thread
		</Link>
	);
	// Runs and collaborations are a bot's, so only a channel or thread with a bot has them.
	if (threadPageId && (conversation.kind === "botThread" || conversation.kind === "botChannel")) {
		return (
			<ActivityThread
				agent={conversation.agent}
				conversationId={conversationId}
				threadId={threadPageId}
				trailing={openChat}
				onOpenThread={onThreadPageChange}
			/>
		);
	}
	return (
		<ConversationPage
			conversation={conversation}
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

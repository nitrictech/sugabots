import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { type ConversationKind, useChatHistory, useMarkItemReadWhileSeen } from "@/lib/chats.ts";
import { conversationLink, routineThreadLink } from "@/lib/links.ts";
import { useThread } from "@/lib/threads.ts";
import { buttonStyles } from "@/ui/button.tsx";
import type { BackTo } from "./ChatHeader.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import type { Staged, StagedChange } from "./ConversationChat.tsx";
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
	/** The channel the item is in; null for a bot's task or a direct message. */
	pod: Pod | null;
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
	onStagedChange: StagedChange;
}) {
	// An automation's own thread opens on its bot's Automations page, beside its other automations.
	const routineId = useThread(conversationId).data?.routine?.id;
	const agent = conversation.kind === "botThread" ? conversation.agent : undefined;
	const openClassName = cn(
		buttonStyles({ variant: "outline", size: "sm" }),
		"shrink-0 max-md:hidden",
	);
	// A phone shows the thread itself, whole, with Back to Inbox; it needs no way to another copy of it.
	const openChat =
		routineId && agent ? (
			<Link {...routineThreadLink(agent, routineId)} className={openClassName}>
				Open thread
			</Link>
		) : pod ? (
			<Link {...conversationLink({ pod, conversationId })} className={openClassName}>
				Open thread
			</Link>
		) : agent ? (
			<Link {...conversationLink({ agent, conversationId })} className={openClassName}>
				Open thread
			</Link>
		) : null;
	// Runs and collaborations are a bot's, so only a task or automation thread has them.
	if (threadPageId && conversation.kind === "botThread") {
		return (
			<ActivityThread
				agent={conversation.agent}
				conversationId={conversationId}
				threadId={threadPageId}
				back={BACK_TO_ACTIVITY}
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

/**
 * A run or collaboration in `agent`'s conversation, as a page of its own,
 * read while it is seen, with `back` before its name.
 */
export function ActivityThread({
	agent,
	conversationId,
	threadId,
	back,
	trailing,
	onOpenThread,
}: {
	agent: Agent;
	conversationId: string;
	threadId: string;
	back: BackTo;
	trailing: ReactNode;
	onOpenThread: (threadId: string) => void;
}) {
	const history = useChatHistory(conversationId);
	useMarkItemReadWhileSeen(threadId);
	return (
		<ChatThreadPanel
			frame={{ kind: "page", back, trailing }}
			conversationId={conversationId}
			chatAgentId={agent.id}
			threadId={threadId}
			entry={history.entries.find((entry) => entry.threadId === threadId)}
			history={history.entries}
			onOpenThread={onOpenThread}
		/>
	);
}

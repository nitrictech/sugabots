import type { Bot, Channel, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import {
	type ConversationPlaceKind,
	useChatHistory,
	useMarkItemReadWhileSeen,
} from "@/lib/chats.ts";
import { useConversation } from "@/lib/conversations.ts";
import { automationFeedLink, conversationLink } from "@/lib/links.ts";
import { buttonStyles } from "@/ui/button.tsx";
import type { BackTo } from "./ChatHeader.tsx";
import type { Staged, StagedChange } from "./ConversationChat.tsx";
import { ConversationPage } from "./ConversationPage.tsx";
import { ItemPanel } from "./ItemPanel.tsx";

const BACK_TO_INBOX: BackTo = { to: "inbox" };

/**
 * What Inbox opens for the item chosen: an automation run or a
 * collaboration as a page of its own, or a message in its chat, jumped to.
 * Either way it is not the conversation's own page, so there is no Details,
 * and the link at the right goes to the conversation itself, or, for an
 * automation's feed, to the automation on the automations page.
 */
export function InboxPane({
	channel,
	conversation,
	conversationId,
	user,
	itemPageId,
	focusMessageId,
	itemConversationId,
	onItemPageChange,
	onItemChange,
	staged,
	onStagedChange,
}: {
	/** The channel the item is in; null for a bot's task or a direct message. */
	channel: Channel | null;
	/** Which kind of conversation the item is in, and its bot when it has one. */
	conversation: ConversationPlaceKind;
	/** The conversation the item is in. */
	conversationId: string;
	user: SessionUser;
	/** A run or collaboration shown as the page, in place of the chat. */
	itemPageId?: string;
	/** A message in the chat to jump to and point out. */
	focusMessageId?: string;
	/** A run or collaboration opened beside the chat, as on its own page. */
	itemConversationId?: string;
	onItemPageChange: (itemConversationId: string) => void;
	onItemChange: (itemConversationId: string | undefined) => void;
	staged?: Staged;
	onStagedChange: StagedChange;
}) {
	// An automation's feed opens on its bot's Automations page, beside its other automations.
	const automationId = useConversation(conversationId).data?.automation?.id;
	const bot = conversation.kind === "botConversation" ? conversation.bot : undefined;
	const openClassName = cn(
		buttonStyles({ variant: "outline", size: "sm" }),
		"shrink-0 max-md:hidden",
	);
	// A phone shows the conversation itself, whole, with Back to Inbox; it needs no way to another copy of it.
	const openChat =
		automationId && bot ? (
			<Link {...automationFeedLink(bot, automationId)} className={openClassName}>
				Open feed
			</Link>
		) : channel ? (
			<Link {...conversationLink({ channel, conversationId })} className={openClassName}>
				Open chat
			</Link>
		) : bot ? (
			<Link {...conversationLink({ bot, conversationId })} className={openClassName}>
				Open task
			</Link>
		) : null;
	// Runs and collaborations happen in a channel's conversations and a bot's, not in direct messages.
	if (itemPageId && conversation.kind !== "directMessage") {
		return (
			<ItemConversationPage
				bot={bot}
				conversationId={conversationId}
				itemConversationId={itemPageId}
				back={BACK_TO_INBOX}
				trailing={openChat}
				onOpenItem={onItemPageChange}
			/>
		);
	}
	return (
		<ConversationPage
			conversation={conversation}
			channel={channel}
			conversationId={conversationId}
			user={user}
			itemConversationId={itemConversationId}
			focusMessageId={focusMessageId}
			away={{ back: BACK_TO_INBOX, trailing: openChat }}
			onItemChange={onItemChange}
			staged={staged}
			onStagedChange={onStagedChange}
		/>
	);
}

/**
 * A run or collaboration in a conversation, `bot`'s task or a channel's, as a
 * page of its own, read while it is seen, with `back` before its name.
 */
export function ItemConversationPage({
	bot,
	conversationId,
	itemConversationId,
	back,
	trailing,
	onOpenItem,
}: {
	/** The bot whose task it is in; undefined in a channel's conversation. */
	bot: Bot | undefined;
	conversationId: string;
	itemConversationId: string;
	back: BackTo;
	trailing: ReactNode;
	onOpenItem: (itemConversationId: string) => void;
}) {
	const history = useChatHistory(conversationId);
	useMarkItemReadWhileSeen(itemConversationId);
	return (
		<ItemPanel
			frame={{ kind: "page", back, trailing }}
			conversationId={conversationId}
			chatBotId={bot?.id}
			itemConversationId={itemConversationId}
			entry={history.entries.find((entry) => entry.conversationId === itemConversationId)}
			history={history.entries}
			onOpenItem={onOpenItem}
		/>
	);
}

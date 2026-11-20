import type { SessionUser } from "@sugabots/contracts";
import { cn } from "cn";
import type { ReactNode } from "react";
import {
	type ConversationPlace,
	placeBot,
	useConversationHistory,
	useMarkItemReadWhileSeen,
} from "@/lib/chats.ts";
import { useConversation } from "@/lib/conversations.ts";
import { OwnerLink } from "@/lib/resource-owner.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import type { BackTo } from "./ChatHeader.tsx";
import { ConversationPage } from "./ConversationPage.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import type { Staged, StagedChange } from "./staged.ts";

const BACK_TO_INBOX: BackTo = { to: "inbox" };

/**
 * What Inbox opens for the item chosen: an automation's run or a
 * collaboration as a page of its own, or a message in its conversation,
 * jumped to. Either way it is not the conversation's own page, so there is no
 * Details, and the link at the right goes to the thread itself, or, for an
 * automation's feed, to the automation's own page among its owner's others.
 */
export function InboxPane({
	conversationPlace,
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
	/** Where the conversation the item is in is. */
	conversationPlace: ConversationPlace;
	/** The conversation the item is in. */
	conversationId: string;
	user: SessionUser;
	/** A run or collaboration shown as the page, in place of the conversation. */
	itemPageId?: string;
	/** A message in the conversation to jump to and point out. */
	focusMessageId?: string;
	/** A run or collaboration opened beside the conversation, as on its own page. */
	itemConversationId?: string;
	onItemPageChange: (itemConversationId: string) => void;
	onItemChange: (itemConversationId: string | undefined) => void;
	staged?: Staged;
	onStagedChange: StagedChange;
}) {
	const automationId = useConversation(conversationId).data?.automation?.id;
	const openClassName = cn(
		buttonStyles({ variant: "secondary", size: "sm" }),
		"shrink-0 max-md:hidden",
	);
	// A phone shows the conversation itself, whole, with Back to Inbox; it needs no way to another copy of it.
	const openThread = automationId ? (
		<OwnerLink
			owner={conversationPlace}
			to={{ page: "automation", automationId }}
			className={openClassName}
		>
			Open feed
		</OwnerLink>
	) : (
		<OwnerLink
			owner={conversationPlace}
			to={{ page: "thread", conversationId }}
			className={openClassName}
		>
			Open thread
		</OwnerLink>
	);
	if (itemPageId) {
		return (
			<ItemConversationPage
				conversationPlace={conversationPlace}
				conversationId={conversationId}
				itemConversationId={itemPageId}
				back={BACK_TO_INBOX}
				trailing={openThread}
				onOpenItem={onItemPageChange}
			/>
		);
	}
	return (
		<ConversationPage
			conversationPlace={conversationPlace}
			conversationId={conversationId}
			user={user}
			itemConversationId={itemConversationId}
			focusMessageId={focusMessageId}
			away={{ back: BACK_TO_INBOX, trailing: openThread }}
			onItemChange={onItemChange}
			staged={staged}
			onStagedChange={onStagedChange}
		/>
	);
}

/**
 * A run or collaboration in a thread, a bot's or a project's, as a page of
 * its own, read while it is seen, with `back` before its name.
 */
export function ItemConversationPage({
	conversationPlace,
	conversationId,
	itemConversationId,
	back,
	trailing,
	onOpenItem,
}: {
	/** Where the thread the item is in is. */
	conversationPlace: ConversationPlace;
	conversationId: string;
	itemConversationId: string;
	back: BackTo;
	trailing: ReactNode;
	onOpenItem: (itemConversationId: string) => void;
}) {
	const history = useConversationHistory(conversationId);
	useMarkItemReadWhileSeen(itemConversationId);
	return (
		<ItemPanel
			frame={{ kind: "page", back, trailing }}
			conversationId={conversationId}
			chatBotId={placeBot(conversationPlace)?.id}
			owner={conversationPlace}
			itemConversationId={itemConversationId}
			entry={history.entries.find((entry) => entry.conversationId === itemConversationId)}
			history={history.entries}
			onOpenItem={onOpenItem}
		/>
	);
}

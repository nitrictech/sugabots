import type { Channel } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type ConversationLinkSearch, conversationLink, taskByIdLink } from "@/lib/links.ts";

/**
 * A link to a conversation people open, where it lives: in `channel` when it
 * is a channel's, else as a task, by its id alone, whose route finds the bot
 * it belongs to. The bot is not taken from the caller, as the bot that did
 * something in a conversation, such as one asked to collaborate, need not be
 * the bot whose task it is. A `Link` takes one route's options, not either of
 * two, so the two are drawn apart.
 */
export function ConversationLink({
	channel,
	conversationId,
	search,
	className,
	children,
}: {
	channel: Pick<Channel, "slug"> | null;
	conversationId: string;
	search?: ConversationLinkSearch;
	className?: string;
	children: ReactNode;
}) {
	return channel ? (
		<Link {...conversationLink({ channel, conversationId }, search)} className={className}>
			{children}
		</Link>
	) : (
		<Link {...taskByIdLink(conversationId, search)} className={className}>
			{children}
		</Link>
	);
}

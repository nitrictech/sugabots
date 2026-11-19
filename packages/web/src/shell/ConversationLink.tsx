import type { Project } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type ConversationLinkSearch, conversationLink, threadByIdLink } from "@/lib/links.ts";

/**
 * A link to a conversation people open, where it lives: in `project` when it
 * is a project's thread, else a bot's thread (its default project has no
 * address of its own), by its id alone, whose route finds the bot. The bot is
 * not taken from the caller, as the bot that did something in a conversation,
 * such as one asked to collaborate, need not be the bot whose thread it is.
 * A `Link` takes one route's options, not either of two, so the two are drawn
 * apart.
 */
export function ConversationLink({
	project,
	conversationId,
	search,
	className,
	children,
}: {
	project: Pick<Project, "slug"> | null;
	conversationId: string;
	search?: ConversationLinkSearch;
	className?: string;
	children: ReactNode;
}) {
	return project ? (
		<Link {...conversationLink({ project, conversationId }, search)} className={className}>
			{children}
		</Link>
	) : (
		<Link {...threadByIdLink(conversationId, search)} className={className}>
			{children}
		</Link>
	);
}

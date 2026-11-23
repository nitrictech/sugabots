import type { Project } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type ChatLinkSearch, chatByIdLink, chatLink } from "@/lib/links.ts";

/**
 * A link to a chat people open, where it lives: in `project` when it
 * is a project's chat, else a bot's chat (its default project has no
 * address of its own), by its id alone, whose route finds the bot. The bot is
 * not taken from the caller, as the bot that did something in a chat,
 * such as one asked to collaborate, need not be the bot whose chat it is.
 * A `Link` takes one route's options, not either of two, so the two are drawn
 * apart.
 */
export function ChatLink({
	project,
	chatId,
	search,
	className,
	children,
}: {
	project: Pick<Project, "slug"> | null;
	chatId: string;
	search?: ChatLinkSearch;
	className?: string;
	children: ReactNode;
}) {
	return project ? (
		<Link {...chatLink({ project, chatId }, search)} className={className}>
			{children}
		</Link>
	) : (
		<Link {...chatByIdLink(chatId, search)} className={className}>
			{children}
		</Link>
	);
}

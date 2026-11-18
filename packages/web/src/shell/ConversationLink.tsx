import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type ConversationLinkSearch, conversationLink } from "@/lib/links.ts";

/**
 * A link to a conversation where it lives: in `pod` when it is a channel's,
 * else as a task of `agent`'s. A `Link` takes one route's options, not either
 * of two, so the two are drawn apart.
 */
export function ConversationLink({
	pod,
	agent,
	conversationId,
	search,
	className,
	children,
}: {
	pod: Pick<Pod, "slug"> | null | undefined;
	agent: Pick<Agent, "handle">;
	conversationId: string;
	search?: ConversationLinkSearch;
	className?: string;
	children: ReactNode;
}) {
	return pod ? (
		<Link {...conversationLink({ pod, conversationId }, search)} className={className}>
			{children}
		</Link>
	) : (
		<Link {...conversationLink({ agent, conversationId }, search)} className={className}>
			{children}
		</Link>
	);
}

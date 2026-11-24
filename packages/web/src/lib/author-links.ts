import type { Participant } from "@sugabots/contracts";
import type { HistoryState } from "@tanstack/react-router";
import { botSettingsLink, memberSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useMemberships, useWorkspace } from "@/lib/workspace.ts";

/** A message's author who has a page: a member or a bot. */
export type PagedAuthor = Exclude<Participant, { kind: "automation_trigger" }>;

/**
 * Where an author's name leads, to spread into a `Link`, with its route
 * forgotten: a `Link` takes one route's options, not either of two, and
 * `botSettingsLink` and `memberSettingsLink` have already checked each.
 */
export interface AuthorLink {
	from: "/$workspace";
	to: string;
	params: Readonly<Record<string, string>>;
	/** For a member's page, which returns to the chat on Back. */
	state?: (state: HistoryState) => HistoryState;
}

/**
 * Where an author's name in a chat leads: a member's page among the
 * workspace's members, whose Back returns to it under `backLabel`, or a bot's
 * settings. Undefined until the memberships are loaded, and for a member who has
 * left the workspace.
 */
export function useAuthorLinks(backLabel: string): (author: PagedAuthor) => AuthorLink | undefined {
	const { workspace } = useWorkspace();
	const memberships = useMemberships(workspace?.id);
	const backHere = useBackToHere(backLabel);
	return (author) => {
		if (author.kind === "bot") return botSettingsLink(author);
		const membership = memberships.data?.find((one) => one.member.id === author.id);
		if (!membership) return undefined;
		return { ...memberSettingsLink(membership), state: backHere };
	};
}

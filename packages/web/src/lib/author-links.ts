import type { Participant } from "@sugabots/contracts";
import type { HistoryState } from "@tanstack/react-router";
import { botSettingsLink, memberSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";

/** A message's author who has a page: a person or a bot. */
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
	state: (state: HistoryState) => HistoryState;
}

/**
 * Where an author's name in a conversation leads, with Back returning to it
 * under `backLabel`: a person's page among the workspace's members, or a bot's
 * settings. Undefined until the members are loaded, and for a person who has
 * left the workspace.
 */
export function useAuthorLinks(backLabel: string): (author: PagedAuthor) => AuthorLink | undefined {
	const { workspace } = useWorkspace();
	const members = useWorkspaceMembers(workspace?.id);
	const backHere = useBackToHere(backLabel);
	return (author) => {
		if (author.kind === "bot") return { ...botSettingsLink(author), state: backHere };
		const membership = members.data?.find((member) => member.user.id === author.id);
		if (!membership) return undefined;
		return { ...memberSettingsLink(membership), state: backHere };
	};
}

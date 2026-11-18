import type { ThreadParticipant } from "@sugabots/contracts";
import type { HistoryState } from "@tanstack/react-router";
import { agentSettingsLink, memberSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";

/** A message's author who has a page: a person or a bot. */
export type PagedAuthor = Exclude<ThreadParticipant, { kind: "routine_trigger" }>;

type BackState = { state: (state: HistoryState) => HistoryState };

/** Kept apart by kind, because a `Link` takes one route's options, not either of two. */
export type AuthorLink =
	| { kind: "agent"; options: ReturnType<typeof agentSettingsLink> & BackState }
	| { kind: "person"; options: ReturnType<typeof memberSettingsLink> & BackState };

/**
 * Where an author's name in a conversation leads, with Back returning to it:
 * a person's page among the workspace's members, or a bot's settings.
 * Undefined until the members are loaded, and for a person who has left the
 * workspace.
 */
export function useAuthorLinks(): (author: PagedAuthor) => AuthorLink | undefined {
	const { workspace } = useWorkspace();
	const members = useWorkspaceMembers(workspace?.id);
	const backToChat = useBackToHere("Chat");
	return (author) => {
		if (author.kind === "agent") {
			return { kind: "agent", options: { ...agentSettingsLink(author), state: backToChat } };
		}
		const membership = members.data?.find((member) => member.user.id === author.id);
		if (!membership) return undefined;
		return { kind: "person", options: { ...memberSettingsLink(membership), state: backToChat } };
	};
}

import type { Participant } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { botSettingsLink, memberSettingsLink } from "@/lib/links.ts";
import { useMemberships, useWorkspace } from "@/lib/workspace.ts";

/** A message's author who has a page: a member or a bot. */
export type PagedAuthor = Exclude<Participant, { kind: "automation_trigger" }>;

/**
 * Where an author's name leads, as the link element to render: a bot's
 * settings page, or a member's page of the settings, opened over the chat.
 */
export type AuthorLink = ReactElement;

/**
 * Where an author's name in a chat leads: a member's page among the
 * workspace's members, or a bot's settings. Undefined until the memberships
 * are loaded, and for a member who has left the workspace.
 */
export function useAuthorLinks(): (author: PagedAuthor) => AuthorLink | undefined {
	const { workspace } = useWorkspace();
	const memberships = useMemberships(workspace?.id);
	return (author) => {
		if (author.kind === "bot") return <Link {...botSettingsLink(author)} />;
		const membership = memberships.data?.find((one) => one.member.id === author.id);
		if (!membership) return undefined;
		return <Link {...memberSettingsLink(membership)} />;
	};
}

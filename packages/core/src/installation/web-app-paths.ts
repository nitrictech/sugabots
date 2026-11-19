/**
 * Paths in the web app, from its root, for the links core writes into
 * notifications, emails and what bots are told. Each must name a route in
 * `packages/web/src/router.tsx`; prefix one with `Installation`'s `webAppUrl`
 * for a link that leaves the app.
 */

import type { PlacedConversationRow } from "../database/schema.ts";

/** Optional query parameters, such as the message to show. */
type Search = Record<string, string>;

const withSearch = (path: string, search: Search = {}) => {
	const query = new URLSearchParams(search).toString();
	return query === "" ? path : `${path}?${query}`;
};

export const projectPath = (workspaceSlug: string, projectSlug: string) =>
	`/${workspaceSlug}/projects/${projectSlug}`;

export const botPath = (workspaceSlug: string, botHandle: string) =>
	`/${workspaceSlug}/bots/${botHandle}`;

/**
 * The automations page of a bot, by its handle, or of a project people made,
 * by its slug: a bot's own automations are its default project's, shown on
 * the bot's page. With `automationId`, that automation on it.
 */
export const automationsPagePath = (
	place: { workspaceSlug: string } & ({ botHandle: string } | { projectSlug: string }),
	automationId?: string,
) => {
	const owner =
		"botHandle" in place
			? botPath(place.workspaceSlug, place.botHandle)
			: projectPath(place.workspaceSlug, place.projectSlug);
	return automationId === undefined
		? `${owner}/automations`
		: `${owner}/automations/${automationId}`;
};

export const botSettingsPath = (workspaceSlug: string, botHandle: string) =>
	`/${workspaceSlug}/settings/bots/${botHandle}`;

/**
 * The Connections page of a bot, by its handle, or of a project people made,
 * by its slug: the services it is connected to. A bot's are its default
 * project's, shown on the bot's page.
 */
export const connectionsPagePath = (
	place: { workspaceSlug: string } & ({ botHandle: string } | { projectSlug: string }),
) =>
	"botHandle" in place
		? `${botPath(place.workspaceSlug, place.botHandle)}/connections`
		: `${projectPath(place.workspaceSlug, place.projectSlug)}/connections`;

export const searchSettingsPath = (workspaceSlug: string) => `/${workspaceSlug}/settings/search`;

export const approvalPath = (workspaceSlug: string, toolCallId: string) =>
	`/${workspaceSlug}/approvals/${toolCallId}`;

/** The conversation `rootConversationId` as the inbox opens it. */
export const inboxPath = (workspaceSlug: string, rootConversationId: string, search?: Search) =>
	withSearch(`/${workspaceSlug}/inbox/${rootConversationId}`, search);

/**
 * Where the conversation `conversationId` opens: in the direct messages, in
 * its project, or as a bot's thread. `projectSlug` is null outside a project.
 */
export const conversationPath = (
	place: {
		workspaceSlug: string;
		kind: PlacedConversationRow["kind"];
		projectSlug: string | null;
	},
	conversationId: string,
	search?: Search,
) => {
	const { workspaceSlug, kind, projectSlug } = place;
	if (kind === "direct_message") {
		return withSearch(`/${workspaceSlug}/dm/${conversationId}`, search);
	}
	if (projectSlug !== null) {
		return withSearch(`${projectPath(workspaceSlug, projectSlug)}/${conversationId}`, search);
	}
	return withSearch(`/${workspaceSlug}/threads/${conversationId}`, search);
};

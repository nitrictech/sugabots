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

export const botAutomationsPath = (workspaceSlug: string, botHandle: string) =>
	`${botPath(workspaceSlug, botHandle)}/automations`;

export const botSettingsPath = (workspaceSlug: string, botHandle: string) =>
	`/${workspaceSlug}/settings/bots/${botHandle}`;

export const botConnectionsPath = (workspaceSlug: string, botHandle: string) =>
	`${botSettingsPath(workspaceSlug, botHandle)}/connections`;

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

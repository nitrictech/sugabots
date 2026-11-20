/**
 * Paths in the web app, from its root, for the links core writes into
 * notifications, emails and what bots are told. Each must name a route in
 * `packages/web/src/router.tsx`; prefix one with `Installation`'s `webAppUrl`
 * for a link that leaves the app.
 */

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

/** A bot, by its handle, or a project people made, by its slug. */
type PagePlace = { workspaceSlug: string } & ({ botHandle: string } | { projectSlug: string });

/**
 * The page of a bot, by its handle, or of a project people made, by its slug;
 * a bot's default project is shown on the bot's page.
 */
const ownerPagePath = (place: PagePlace) =>
	"botHandle" in place
		? botPath(place.workspaceSlug, place.botHandle)
		: projectPath(place.workspaceSlug, place.projectSlug);

/**
 * The automations page of a bot, by its handle, or of a project people made,
 * by its slug: a bot's own automations are its default project's, shown on
 * the bot's page. With `automationId`, that automation on it.
 */
export const automationsPagePath = (place: PagePlace, automationId?: string) =>
	automationId === undefined
		? `${ownerPagePath(place)}/automations`
		: `${ownerPagePath(place)}/automations/${automationId}`;

/** A bot's settings, by its handle: a page of the bot's own, beside its threads. */
export const botSettingsPath = (workspaceSlug: string, botHandle: string) =>
	`${botPath(workspaceSlug, botHandle)}/settings`;

/**
 * The Connections page of a bot, by its handle, or of a project people made,
 * by its slug: the services it is connected to. A bot's are its default
 * project's, shown on the bot's page.
 */
export const connectionsPagePath = (place: PagePlace) => `${ownerPagePath(place)}/connections`;

export const searchSettingsPath = (workspaceSlug: string) => `/${workspaceSlug}/settings/search`;

export const approvalPath = (workspaceSlug: string, toolCallId: string) =>
	`/${workspaceSlug}/approvals/${toolCallId}`;

/** The conversation `rootConversationId` as the inbox opens it. */
export const inboxPath = (workspaceSlug: string, rootConversationId: string, search?: Search) =>
	withSearch(`/${workspaceSlug}/inbox/${rootConversationId}`, search);

/**
 * Where the conversation `conversationId` opens: in its project, or as a
 * bot's thread. `projectSlug` is null outside a project people made.
 */
export const conversationPath = (
	place: { workspaceSlug: string; projectSlug: string | null },
	conversationId: string,
	search?: Search,
) => {
	const { workspaceSlug, projectSlug } = place;
	if (projectSlug !== null) {
		return withSearch(`${projectPath(workspaceSlug, projectSlug)}/${conversationId}`, search);
	}
	return withSearch(`/${workspaceSlug}/threads/${conversationId}`, search);
};

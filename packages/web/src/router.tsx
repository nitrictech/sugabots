import { useQueryClient } from "@tanstack/react-query";
import type { ParsedLocation, RouterHistory } from "@tanstack/react-router";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { followTrail, historyIndex } from "@/lib/history-trail.ts";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { type Session, SessionContext } from "@/lib/session.ts";
import { PageFailure } from "@/shell/PageFailure.tsx";
import { approvalRoute, approvalsIndexRoute, approvalsRoute } from "./routes/approvals.tsx";
import {
	automationFeedRoute,
	automationsIndexRoute,
	automationsRoute,
	newAutomationRoute,
	projectAutomationRoute,
	projectAutomationsIndexRoute,
	projectAutomationsRoute,
	projectNewAutomationRoute,
} from "./routes/automations.tsx";
import {
	botFileRoute,
	botFilesRoute,
	botIndexRoute,
	botRoute,
	botsRoute,
	threadByIdRoute,
	threadRoute,
} from "./routes/bots.tsx";
import { gitHubSetupReturnRoute, signInReturnRoute } from "./routes/connection-returns.tsx";
import {
	directMessageRoute,
	directMessagesIndexRoute,
	directMessagesRoute,
	newDirectMessageRoute,
} from "./routes/direct-messages.tsx";
import { inboxConversationRoute, inboxIndexRoute, inboxRoute } from "./routes/inbox.tsx";
import { onboardingRoute } from "./routes/onboarding.tsx";
import {
	projectFileRoute,
	projectFilesRoute,
	projectIndexRoute,
	projectNewThreadRoute,
	projectRoute,
	projectsRoute,
	projectThreadRoute,
} from "./routes/projects.tsx";
import { type RouterContext, rootRoute } from "./routes/root.tsx";
import {
	settingsBotConnectionRoute,
	settingsBotPageRoute,
	settingsBotRoute,
	settingsDefaultModelRoute,
	settingsMemberRoute,
	settingsProjectConnectionRoute,
	settingsProjectPageRoute,
	settingsProjectRoute,
	settingsProviderRoute,
	settingsRoute,
	settingsSectionRoute,
	settingsSystemModelRoute,
} from "./routes/settings.tsx";
import { inviteRoute, joinRoute, loginRoute, resetPasswordRoute } from "./routes/sign-in.tsx";
import {
	homeRoute,
	indexRoute,
	shellRoute,
	workspaceIndexRoute,
	youRoute,
} from "./routes/workspace.tsx";

/*
 * The routes, declared rather than generated.
 *
 * A file-based tree would write `routeTree.gen.ts` for us; a hand-built one
 * keeps the shape of the app readable in one screen and adds nothing for CI to
 * regenerate or for Biome to be told to skip. The tree is small and the paths
 * are the product's vocabulary, so it is worth reading:
 *
 *   /                        opens the workspace last chosen
 *   /login
 *   /reset-password           where a password reset email's link lands
 *   /join/$code               where a referral link lands
 *   /invite/$id
 *   /connections/oauth/return        where a connection's sign-in comes back
 *   /connections/github/return       where installing a project's GitHub app comes back
 *   /onboarding              setting up a workspace, the first or another
 *   /$workspace              the person's Personal Assistant
 *   /$workspace/home         on a phone, Home: the Personal Assistant, projects and pinned bots
 *   /$workspace/you          on a phone, You: the workspace, its settings and signing out
 *   /$workspace/settings     workspace settings
 *   /$workspace/inbox     what is new across the workspace: mentions, unread messages, automation runs and collaborations
 *   /$workspace/inbox/$conversation   the conversation, run or collaboration of the one chosen, beside them
 *   /$workspace/dm           your direct messages with other people
 *   /$workspace/dm/new       starting one, with one person or a group
 *   /$workspace/dm/$conversation   one of them, by its id, `?message=` jumped to
 *   /$workspace/approvals    every approval across the workspace
 *   /$workspace/approvals/$call   one of them in full, by its tool call's id
 *   /$workspace/projects     every project the person is in or could join
 *   /$workspace/projects/$project   a project, which opens its newest thread, or a new one; on a phone, its sidebar
 *   /$workspace/projects/$project/new   starting a thread from its first message
 *   /$workspace/projects/$project/$conversation   one of its threads
 *   /$workspace/projects/$project/files[/$file]   the files made in it
 *   /$workspace/projects/$project/automations[/new|/$automation]   its automations
 *   /$workspace/bots         every bot the person reaches
 *   /$workspace/bots/$bot    a bot, starting a thread with it from its first message
 *   /$workspace/bots/$bot/threads/$conversation   one of its threads, or an automation's feed
 *   /$workspace/bots/$bot/files[/$file]   the files it made
 *   /$workspace/bots/$bot/automations[/new|/$automation]   its automations
 *   /$workspace/threads/$conversation   a thread by its id alone, which goes on to its bot's address
 *   /$workspace/settings/members/$member   one person, by membership id
 *   /$workspace/settings/projects/$project[/$page]   a project's settings: General, People, Bots, Connections or Computer
 *   /$workspace/settings/projects/$project/connections/$connection   one connection, by id
 *   /$workspace/settings/bots/$bot[/$page]   a bot's settings: General, Connections or Computer
 *   /$workspace/settings/bots/$bot/connections/$connection   one connection, by id
 *   /$workspace/settings/providers/$provider   one model provider
 *   /$workspace/settings/providers/default  the model new bots start on
 *   /$workspace/settings/providers/system   the model the system bots use
 *
 * A bot's address uses its handle, unique in its workspace, rather than its
 * name, so renaming a bot keeps its links. A collaboration or automation run
 * has no address of its own: it opens beside its conversation, as `?item=`.
 *
 * Each area's routes and their pages are declared in a module of its own under
 * `routes/`; the tree below puts them together.
 */

const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	joinRoute,
	resetPasswordRoute,
	inviteRoute,
	signInReturnRoute,
	gitHubSetupReturnRoute,
	onboardingRoute,
	shellRoute.addChildren([
		workspaceIndexRoute,
		settingsRoute,
		settingsSectionRoute,
		settingsMemberRoute,
		settingsProjectRoute,
		settingsProjectPageRoute,
		settingsProjectConnectionRoute,
		settingsBotRoute,
		settingsBotPageRoute,
		settingsBotConnectionRoute,
		settingsSystemModelRoute,
		settingsDefaultModelRoute,
		settingsProviderRoute,
		inboxRoute.addChildren([inboxIndexRoute, inboxConversationRoute]),
		approvalsRoute.addChildren([approvalsIndexRoute, approvalRoute]),
		directMessagesRoute.addChildren([
			directMessagesIndexRoute,
			newDirectMessageRoute,
			directMessageRoute,
		]),
		youRoute,
		homeRoute,
		projectsRoute,
		botsRoute,
		threadByIdRoute,
		projectRoute.addChildren([
			projectIndexRoute,
			projectNewThreadRoute,
			projectFilesRoute,
			projectFileRoute,
			projectAutomationsRoute.addChildren([
				projectAutomationsIndexRoute,
				projectNewAutomationRoute,
				projectAutomationRoute,
			]),
			projectThreadRoute,
		]),
		botRoute.addChildren([
			botIndexRoute,
			threadRoute,
			botFilesRoute,
			botFileRoute,
			automationsRoute.addChildren([
				automationsIndexRoute,
				newAutomationRoute,
				automationFeedRoute,
			]),
		]),
	]),
]);

/**
 * Which way a phone slides from one page to the next, as a view transition's
 * type: `forward` into a page further in, as a project opened from Home or a
 * thread from its project, and `back` out of one. Switching tabs, or a change
 * that stays on its page, such as opening a bot's computer, does not slide.
 */
function phoneSlide({
	fromLocation,
	toLocation,
	hrefChanged,
}: {
	fromLocation?: ParsedLocation;
	toLocation: ParsedLocation;
	hrefChanged: boolean;
}): string[] | false {
	if (!fromLocation || !hrefChanged || matchesMedia(SIDE_BY_SIDE)) return false;
	const fromIndex = historyIndex(fromLocation);
	const toIndex = historyIndex(toLocation);
	const from = locationDepth(fromLocation);
	const to = locationDepth(toLocation);
	// In place: a page that sends on to its own address, as a bot's chat does, doesn't
	// slide, but Back from a page opened first, which goes up in its place, does.
	if (toIndex === fromIndex) return to < from ? ["back"] : false;
	if (to !== from) return [to > from ? "forward" : "back"];
	// A tab for another tab.
	if (to === 0) return false;
	// Pages as deep as each other, as two threads in a project are: a step
	// through history tells which way, a page opened going forward and Back going back.
	return [toIndex > fromIndex ? "forward" : "back"];
}

/** Whether `pathname` is one of the settings, or a phone's You tab, which lists them. */
function isSettingsPath(pathname: string): boolean {
	const [section] = pathname.split("/").filter(Boolean).slice(1);
	return section === "settings" || section === "you";
}

/**
 * A page's depth, and a step more while an item is open over it: a run or
 * collaboration opened from a chat or from Inbox, which the address names in
 * its search rather than its path.
 */
function locationDepth(location: ParsedLocation): number {
	const search = location.search as { item?: unknown; itemPage?: unknown };
	const itemOpen = search.item !== undefined || search.itemPage !== undefined;
	return pageDepth(location.pathname) + (itemOpen ? 1 : 0);
}

/**
 * How far into the app a page is on a phone: a tab is 0; what it opens, 1; and
 * so on. A bot's thread is a step past the bot's own page, though its address is
 * no longer, so depth is told from what the address names, not its length.
 */
function pageDepth(pathname: string): number {
	// The workspace's own part of the address is the same everywhere, so it counts for nothing.
	const [section, ...rest] = pathname.split("/").filter(Boolean).slice(1);
	switch (section) {
		case "projects":
		case "bots": {
			// projects/$project or bots/$bot is one in; what those open, two; files/$file or threads/$thread, three.
			const [, place, item] = rest;
			if (rest.length === 0) return 0;
			if (place === undefined) return 1;
			return item === undefined ? 2 : 3;
		}
		case "threads":
			return 2;
		case "inbox":
		case "approvals":
		case "dm":
			return rest.length === 0 ? 0 : 1;
		case "you":
		case "home":
			return 0;
		case "settings":
			// Opened from You, so one in at least, and a step more for each part of the address.
			return 1 + rest.length;
		default:
			return 0;
	}
}

export function createAppRouter(options?: {
	history?: RouterHistory;
	/** Off where nothing watches the page slide, as in stories, so a quick redirect can't interrupt one. */
	defaultViewTransition?: false;
}) {
	const router = createRouter({
		routeTree,
		// Supplied by `RouterProvider` once the session is known.
		context: undefined as unknown as RouterContext,
		defaultPreload: "intent",
		// On a phone, a page further in slides over the one it was opened from, and back slides it away.
		defaultViewTransition: { types: phoneSlide },
		// Back to a list of settings returns to where it was left, not its top. Only settings:
		// a chat opens at its latest instead. What scrolls is named by `data-scroll-restoration-id`.
		scrollRestoration: ({ location }) => isSettingsPath(location.pathname),
		// A boundary for every route, so a failed page is replaced inside its parent and the sidebar
		// stays. The router's own boundary is above the root.
		defaultErrorComponent: PageFailure,
		// Tests mount the real tree over a memory history, so a route's guards
		// and search params are exercised rather than mocked around.
		...options,
	});
	// So Back can tell where going back would land.
	followTrail(router);
	return router;
}

/** The app's routes, signed in as `session`: guards read who you are from it, and so do components. */
export function AppRouterProvider({
	router,
	session,
}: {
	router: ReturnType<typeof createAppRouter>;
	session: Session;
}) {
	const queries = useQueryClient();
	return (
		<SessionContext value={session}>
			<RouterProvider router={router} context={{ user: session.user, queries }} />
		</SessionContext>
	);
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}

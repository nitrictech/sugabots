import { useQueryClient } from "@tanstack/react-query";
import type { ParsedLocation, RouterHistory } from "@tanstack/react-router";
import { createRouter, defaultStringifySearch, RouterProvider } from "@tanstack/react-router";
import { followTrail, historyIndex } from "@/lib/history-trail.ts";
import { matchesMedia, REDUCED_MOTION, SIDE_BY_SIDE } from "@/lib/media.ts";
import { hasSettingsOpen, type SettingsLocation, settingsLocationOf } from "@/lib/open-settings.ts";
import { type Session, SessionContext } from "@/lib/session.ts";
import { PageFailure } from "@/shell/PageFailure.tsx";
import { approvalRoute, approvalsIndexRoute, approvalsRoute } from "./routes/approvals.tsx";
import {
	automationRoute,
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
	botNewChatRoute,
	botRoute,
	botsRoute,
	chatByIdRoute,
	chatRoute,
} from "./routes/bots.tsx";
import { gitHubSetupReturnRoute, signInReturnRoute } from "./routes/connector-returns.tsx";
import {
	botConnectorRoute,
	botConnectorsRoute,
	projectConnectorRoute,
	projectConnectorsRoute,
} from "./routes/connectors.tsx";
import {
	botComputerRoute,
	botSettingsRoute,
	projectBotsRoute,
	projectComputerRoute,
	projectMembersRoute,
	projectSettingsRoute,
} from "./routes/owner-settings.tsx";
import {
	projectChatRoute,
	projectFileRoute,
	projectFilesRoute,
	projectIndexRoute,
	projectNewChatRoute,
	projectRoute,
	projectsRoute,
} from "./routes/projects.tsx";
import { type RouterContext, rootRoute } from "./routes/root.tsx";
import { settingsPageRoute, settingsRoute } from "./routes/settings.tsx";
import { invitationRoute, joinRoute, resetPasswordRoute, signInRoute } from "./routes/sign-in.tsx";
import {
	homeRoute,
	indexRoute,
	shellRoute,
	workspaceIndexRoute,
	youRoute,
} from "./routes/workspace.tsx";
import { workspaceSetupRoute } from "./routes/workspace-setup.tsx";

/*
 * The routes, declared rather than generated.
 *
 * A file-based tree would write `routeTree.gen.ts` for us; a hand-built one
 * keeps the shape of the app readable in one screen and adds nothing for CI to
 * regenerate or for Biome to be told to skip. The tree is small and the paths
 * are the product's vocabulary, so it is worth reading:
 *
 *   /                        opens the workspace last chosen
 *   /sign-in
 *   /reset-password           where a password reset email's link lands
 *   /join/$code               where a referral link lands
 *   /invitations/$id
 *   /connectors/oauth/return        where a connector's sign-in comes back
 *   /connectors/github/return       where installing a project's GitHub app comes back
 *   /workspace-setup         setting up a workspace, the first or another
 *   /$workspace              the member's oldest Personal Assistant
 *   /$workspace/home         on a phone, Home: the Personal Assistants, projects and pinned bots
 *   /$workspace/you          on a phone, You: the workspace, its settings and signing out
 *   /$workspace/settings[/…]   where settings were before they were a dialog, which opens them
 *   /$workspace/approvals    every approval across the workspace
 *   /$workspace/approvals/$call   one of them in full, by its tool call's id
 *   /$workspace/projects     every project the member is in or could join
 *   /$workspace/projects/$project   a project, which opens its newest chat, or a new one; on a phone, its sidebar
 *   /$workspace/projects/$project/new   starting a chat from its first message
 *   /$workspace/projects/$project/$chat   one of its chats
 *   /$workspace/projects/$project/files[/$file]   the files made in it
 *   /$workspace/projects/$project/connectors[/$connector]   the services it is connected to
 *   /$workspace/projects/$project/settings[/members|/bots]   its settings, and its members and bots
 *   /$workspace/projects/$project/computer   its computer
 *   /$workspace/projects/$project/automations[/new|/$automation]   its automations
 *   /$workspace/bots         every bot the member reaches
 *   /$workspace/bots/$bot    a bot, starting a chat with it from its first message
 *   /$workspace/bots/$bot/chats/$chat   one of its chats, or an automation's feed
 *   /$workspace/bots/$bot/files[/$file]   the files it made
 *   /$workspace/bots/$bot/connectors[/$connector]   the services it is connected to
 *   /$workspace/bots/$bot/settings   its settings
 *   /$workspace/bots/$bot/computer   its computer
 *   /$workspace/bots/$bot/automations[/new|/$automation]   its automations
 *   /$workspace/chats/$chat   a chat by its id alone, which goes on to its bot's address
 *
 * Your settings and the workspace's open over any of these as a dialog,
 * which the search names as `?settings=` and the page of them open:
 *
 *   ?settings=                  the list of sections, with General beside it on a laptop
 *   ?settings=$section          a section, such as `members` or `notifications`
 *   ?settings=members/$membership   one member, by membership id
 *   ?settings=providers/$provider   one model provider
 *   ?settings=providers/default   the model new bots start on
 *   ?settings=providers/system    the model the system bots use
 *
 * A bot's address uses its handle, unique in its workspace, rather than its
 * name, so renaming a bot keeps its links. An automation run has no address
 * of its own: its feed's address names it as `?runChat=`, to open the feed at it.
 *
 * Each area's routes and their pages are declared in a module of its own under
 * `routes/`; the tree below puts them together.
 */

const routeTree = rootRoute.addChildren([
	indexRoute,
	signInRoute,
	joinRoute,
	resetPasswordRoute,
	invitationRoute,
	signInReturnRoute,
	gitHubSetupReturnRoute,
	workspaceSetupRoute,
	shellRoute.addChildren([
		workspaceIndexRoute,
		settingsRoute,
		settingsPageRoute,
		approvalsRoute.addChildren([approvalsIndexRoute, approvalRoute]),
		youRoute,
		homeRoute,
		projectsRoute,
		botsRoute,
		chatByIdRoute,
		projectRoute.addChildren([
			projectIndexRoute,
			projectNewChatRoute,
			projectFilesRoute,
			projectFileRoute,
			projectConnectorsRoute,
			projectConnectorRoute,
			projectSettingsRoute,
			projectMembersRoute,
			projectBotsRoute,
			projectComputerRoute,
			projectAutomationsRoute.addChildren([
				projectAutomationsIndexRoute,
				projectNewAutomationRoute,
				projectAutomationRoute,
			]),
			projectChatRoute,
		]),
		botRoute.addChildren([
			botIndexRoute,
			botNewChatRoute,
			chatRoute,
			botFilesRoute,
			botFileRoute,
			botConnectorsRoute,
			botConnectorRoute,
			botSettingsRoute,
			botComputerRoute,
			automationsRoute.addChildren([automationsIndexRoute, newAutomationRoute, automationRoute]),
		]),
	]),
]);

/** Whether `pathname` is one of a bot's or a project's own pages, which the icon rail stands beside. */
function isOwnerPath(pathname: string): boolean {
	return /^\/[^/]+\/(bots|projects)\/[^/]+/.test(pathname);
}

/**
 * The view transition between two pages, by its types: a phone's slide, or,
 * from a tablet up, `rail` between the sidebar and a bot's or a project's own
 * pages, on which its marks move between the sidebar's rows and the icon rail.
 * None under reduced motion, as the browser would otherwise cross-fade the pages.
 *
 * Whether the rail was showing is judged by the page the last navigation went
 * to, not the one the router last finished on: a page that sends on to
 * another as it opens, as a project's opens its newest chat, is still opening
 * when it does, so judged by the page before, it would start a second `rail`
 * transition that cuts the first short.
 */
function pageTransitions() {
	let railShowing: boolean | undefined;
	return (locations: {
		fromLocation?: ParsedLocation;
		toLocation: ParsedLocation;
		hrefChanged: boolean;
	}): string[] | false => {
		const { fromLocation, toLocation } = locations;
		const railWasShowing =
			railShowing ?? (fromLocation !== undefined && isOwnerPath(fromLocation.pathname));
		railShowing = isOwnerPath(toLocation.pathname);
		if (matchesMedia(REDUCED_MOTION)) return false;
		if (!matchesMedia(SIDE_BY_SIDE)) return phoneSlide(locations);
		if (!fromLocation) return false;
		return railWasShowing !== railShowing ? ["rail"] : false;
	};
}

/**
 * Which way a phone slides from one page to the next, as a view transition's
 * type: `forward` into a page further in, as a project opened from Home or a
 * chat from its project, and `back` out of one. Switching tabs, or a change
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
	if (!fromLocation || !hrefChanged) return false;
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
	// Pages as deep as each other, as two chats in a project are: a step
	// through history tells which way, a page opened going forward and Back going back.
	return [toIndex > fromIndex ? "forward" : "back"];
}

/** Whether `location` has settings open, or is a phone's You tab, which lists them. */
function isSettingsLocation(location: ParsedLocation): boolean {
	const [section] = location.pathname.split("/").filter(Boolean).slice(1);
	return section === "you" || hasSettingsOpen(location);
}

/**
 * A page's depth, and more for any settings page its search opens over it,
 * rather than its path.
 */
function locationDepth(location: ParsedLocation): number {
	const settings = settingsLocationOf((location.search as { settings?: unknown }).settings);
	return pageDepth(location.pathname) + (settings ? settingsDepth(settings) : 0);
}

/**
 * How far into the settings a page of them is on a phone, from the page they
 * are open over: a section is one in, as is the list a wider screen opens;
 * a member, a provider or a default model, a step past its section; and
 * Notifications, opened from your account, a step past it too.
 */
function settingsDepth(page: SettingsLocation): number {
	switch (page.kind) {
		case "sections":
			return 1;
		case "section":
			return page.section === "notifications" ? 2 : 1;
		case "member":
		case "provider":
		case "model":
			return 2;
	}
}

/**
 * How far into the app a page is on a phone: a tab is 0; what it opens, 1; and
 * so on. A bot's page, /bots/$bot, is 1, and its chat, /bots/$bot/chats/$chat,
 * is 3. A chat opened from a notification at the shorter /chats/$chat is 2, a
 * step past the tab it was opened from.
 */
function pageDepth(pathname: string): number {
	// The workspace's own part of the address is the same everywhere, so it counts for nothing.
	const [section, ...rest] = pathname.split("/").filter(Boolean).slice(1);
	switch (section) {
		case "projects":
		case "bots": {
			// projects/$project or bots/$bot is one in; what those open, two; files/$file or chats/$chat, three.
			const [, place, item] = rest;
			if (rest.length === 0) return 0;
			if (place === undefined) return 1;
			return item === undefined ? 2 : 3;
		}
		case "chats":
			return 2;
		case "approvals":
			return rest.length === 0 ? 0 : 1;
		case "you":
		case "home":
			return 0;
		default:
			return 0;
	}
}

/**
 * The search as the router writes it, but with its slashes left as they are,
 * which a query may hold: `?settings=members/…` rather than `members%2F…`.
 */
function stringifySearchWithReadableSlashes(search: Record<string, unknown>): string {
	return defaultStringifySearch(search).replaceAll("%2F", "/");
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
		defaultViewTransition: { types: pageTransitions() },
		// Back to a list of settings returns to where it was left, not its top. Only settings:
		// a chat opens at its latest instead. What scrolls is named by `data-scroll-restoration-id`.
		scrollRestoration: ({ location }) => isSettingsLocation(location),
		stringifySearch: stringifySearchWithReadableSlashes,
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
			<RouterProvider router={router} context={{ member: session.member, queries }} />
		</SessionContext>
	);
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}

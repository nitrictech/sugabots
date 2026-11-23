import { createRoute, Outlet, useMatch, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useOpenAutomationFeed } from "@/lib/chats.ts";
import {
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { AutomationsPage } from "@/shell/Automations.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { BotConversation, botRoute } from "./bots.tsx";
import { ConversationPage } from "./conversation.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner, useProjectRouteOwner } from "./owner.ts";
import { ProjectConversation, projectRoute } from "./projects.tsx";
import { type ConversationSearch, validateConversationSearch } from "./search.ts";

const AutomationSetup = lazyNamed(
	() =>
		import("@/screens/AutomationEditing.tsx").then(({ AutomationSetup }) => ({ AutomationSetup })),
	"AutomationSetup",
);
const NewAutomation = lazyNamed(
	() => import("@/screens/AutomationEditing.tsx").then(({ NewAutomation }) => ({ NewAutomation })),
	"NewAutomation",
);

/*
 * A bot's automations and a project's, the same pages at each one's address:
 * listed as a page, which an automation, a run of one, or a new one takes the
 * place of.
 */

/** The list, with what an address under it opens in its place as `children`. */
function OwnerAutomations({
	owner,
	making,
	children,
}: {
	owner: ResourceOwner | undefined;
	making: boolean;
	children: ReactNode;
}) {
	const { automation } = useParams({ strict: false });
	if (!owner) return null;
	return (
		<AutomationsPage owner={owner} selectedAutomationId={automation} making={making}>
			{children}
		</AutomationsPage>
	);
}

/**
 * An automation's own page: how it is set up, under its breadcrumb. With
 * `?itemPage=`, one of its runs instead, as the sidebar opens them.
 */
function AutomationPage<Owner extends ResourceOwner>({
	owner,
	automationId,
	itemPage,
	feed,
}: {
	owner: Owner | undefined;
	automationId: string;
	itemPage: string | undefined;
	/** The automation's feed, open with the run as its page. */
	feed: (owner: Owner, feedId: string) => ReactNode;
}) {
	if (!owner) return null;
	// A run is history, which somebody who manages the bot without reaching it does not read.
	return itemPage && resourcePermissions(owner).readHistory ? (
		<AutomationFeed key={automationId} owner={owner} automationId={automationId} feed={feed} />
	) : (
		<AutomationSetup key={automationId} owner={owner} automationId={automationId} />
	);
}

/** The automation's feed, opened first when it has none, with the run `?itemPage=` names as the page. */
function AutomationFeed<Owner extends ResourceOwner>({
	owner,
	automationId,
	feed,
}: {
	owner: Owner;
	automationId: string;
	feed: (owner: Owner, feedId: string) => ReactNode;
}) {
	const opened = useOpenAutomationFeed(resourceProjectId(owner), automationId);
	if (opened.isError) {
		return (
			<EmptyState title="Could not open this automation">
				It may have been removed. Reload this page to try again.
			</EmptyState>
		);
	}
	if (!opened.data) return null;
	return feed(owner, opened.data.id);
}

/** A bot's automations, listed as a page. */
export const automationsRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/automations",
	component: () => (
		<OwnerAutomations
			owner={useBotRouteOwner()}
			making={useMatch({ from: newAutomationRoute.id, shouldThrow: false }) !== undefined}
		>
			<Outlet />
		</OwnerAutomations>
	),
});

/** An automation being made, in the place of the bot's automations. */
export const newAutomationRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/new",
	component: () => {
		const owner = useBotRouteOwner();
		// Keyed by where it is made, so moving to another bot's starts a new one there.
		return owner ? <NewAutomation key={resourceProjectId(owner)} owner={owner} /> : null;
	},
});

export const automationsIndexRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/",
	component: () => null,
});

export const automationFeedRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/$automation",
	validateSearch: validateConversationSearch,
	loader: () => ConversationPage.preload(),
	component: () => {
		const { automation } = automationFeedRoute.useParams();
		const search = automationFeedRoute.useSearch();
		const navigate = automationFeedRoute.useNavigate();
		return (
			<AutomationPage
				owner={useBotRouteOwner()}
				automationId={automation}
				itemPage={search.itemPage}
				feed={(owner, feedId) => (
					<BotConversation
						bot={owner.bot}
						conversationId={feedId}
						search={search}
						navigate={(change) => void navigate(change)}
					/>
				)}
			/>
		);
	},
});

/** A project's automations, listed as a page, as a bot's are. */
export const projectAutomationsRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/automations",
	component: () => (
		<OwnerAutomations
			owner={useProjectRouteOwner()}
			making={useMatch({ from: projectNewAutomationRoute.id, shouldThrow: false }) !== undefined}
		>
			<Outlet />
		</OwnerAutomations>
	),
});

export const projectNewAutomationRoute = createRoute({
	getParentRoute: () => projectAutomationsRoute,
	path: "/new",
	component: () => {
		const owner = useProjectRouteOwner();
		return owner ? <NewAutomation key={resourceProjectId(owner)} owner={owner} /> : null;
	},
});

export const projectAutomationsIndexRoute = createRoute({
	getParentRoute: () => projectAutomationsRoute,
	path: "/",
	component: () => null,
});

export const projectAutomationRoute = createRoute({
	getParentRoute: () => projectAutomationsRoute,
	path: "/$automation",
	validateSearch: validateConversationSearch,
	loader: () => ConversationPage.preload(),
	component: () => {
		const { automation } = projectAutomationRoute.useParams();
		const search = projectAutomationRoute.useSearch();
		const navigate = projectAutomationRoute.useNavigate();
		return (
			<AutomationPage
				owner={useProjectRouteOwner()}
				automationId={automation}
				itemPage={search.itemPage}
				feed={(owner, feedId) => (
					<ProjectConversation
						projectSlug={owner.project.slug}
						conversationId={feedId}
						search={search satisfies ConversationSearch}
						navigate={(change) => void navigate(change)}
					/>
				)}
			/>
		);
	},
});

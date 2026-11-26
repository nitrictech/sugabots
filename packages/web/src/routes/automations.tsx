import {
	createRoute,
	Navigate,
	Outlet,
	useLocation,
	useMatch,
	useParams,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useProjectChats } from "@/lib/chats.ts";
import { chatLink } from "@/lib/links.ts";
import {
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { BotAutomationRestrictions } from "@/screens/BotRestrictions.tsx";
import { AutomationsPage } from "@/shell/Automations.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { botRoute } from "./bots.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner, useProjectRouteOwner } from "./owner.ts";
import { projectRoute } from "./projects.tsx";
import { decodeRouteId, legacyRunSearch } from "./search.ts";

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
 * listed as a page, which an automation or a new one takes the place of.
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
	if ("bot" in owner && !owner.bot.permissions.talk) {
		return <BotAutomationRestrictions bot={owner.bot} />;
	}
	return (
		<AutomationsPage owner={owner} selectedAutomationId={automation} making={making}>
			{children}
		</AutomationsPage>
	);
}

/** An automation's own page: how it is set up, under its breadcrumb. */
function AutomationPage({
	owner,
	automationId,
}: {
	owner: ResourceOwner | undefined;
	automationId: string;
}) {
	const runSearch = useLocation({ select: (location) => legacyRunSearch(location.search) });
	if (!owner) return null;
	if (runSearch && resourcePermissions(owner).readHistory) {
		return <LegacyRunRedirect owner={owner} automationId={automationId} search={runSearch} />;
	}
	return <AutomationSetup key={automationId} owner={owner} automationId={automationId} />;
}

function LegacyRunRedirect({
	owner,
	automationId,
	search,
}: {
	owner: ResourceOwner;
	automationId: string;
	search: { runChat: string };
}) {
	const listed = useProjectChats(resourceProjectId(owner));
	if (listed.isPending) return null;
	const feed = listed.data?.automations.find(
		({ automation }) => automation.id === automationId,
	)?.chat;
	if (!feed) return <EmptyState title="Could not open this automation" />;
	const destination =
		"bot" in owner
			? chatLink({ bot: owner.bot, chatId: feed.id }, search)
			: chatLink({ project: owner.project, chatId: feed.id }, search);
	return <Navigate {...destination} replace />;
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

export const automationRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/$automation",
	params: { parse: ({ automation }) => ({ automation: decodeRouteId(automation) }) },
	component: () => (
		<AutomationPage
			owner={useBotRouteOwner()}
			automationId={automationRoute.useParams().automation}
		/>
	),
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
	params: { parse: ({ automation }) => ({ automation: decodeRouteId(automation) }) },
	component: () => (
		<AutomationPage
			owner={useProjectRouteOwner()}
			automationId={projectAutomationRoute.useParams().automation}
		/>
	),
});

import type { Bot } from "@sugabots/contracts";
import { createRoute, Navigate, Outlet, useMatch, useParams } from "@tanstack/react-router";
import { useBotWithHandle } from "@/lib/bots.ts";
import { useOpenAutomationFeed } from "@/lib/chats.ts";
import { newAutomationLink } from "@/lib/links.ts";
import { AutomationsPage, useListedAutomations } from "@/shell/Automations.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { BotConversation, botRoute } from "./bots.tsx";
import { ConversationPage } from "./conversation.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { validateConversationSearch } from "./search.ts";

// Its own export, or the module's other exports would decide the props.
const AutomationSetup = lazyNamed(
	() =>
		import("@/screens/AutomationEditing.tsx").then(({ AutomationSetup }) => ({ AutomationSetup })),
	"AutomationSetup",
);
// Its own export, or the module's other exports would decide the props.
const NewAutomation = lazyNamed(
	() => import("@/screens/AutomationEditing.tsx").then(({ NewAutomation }) => ({ NewAutomation })),
	"NewAutomation",
);

/** A bot's automations, listed as a page, which an automation, a run of one, or a new one takes the place of. */
export const automationsRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/automations",
	component: () => {
		const { bot: handle } = automationsRoute.useParams();
		const { automation } = useParams({ strict: false });
		const making = useMatch({ from: newAutomationRoute.id, shouldThrow: false }) !== undefined;
		const { bot } = useBotWithHandle(handle);
		return bot ? (
			<AutomationsPage bot={bot} selectedAutomationId={automation} making={making}>
				<Outlet />
			</AutomationsPage>
		) : null;
	},
});

/** An automation being made, in the place of the bot's automations. */
export const newAutomationRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/new",
	component: () => {
		const { bot } = useBotWithHandle(newAutomationRoute.useParams().bot);
		return bot ? <NewAutomation bot={bot} /> : null;
	},
});

/**
 * With none chosen, the list is the page. A bot with no automations yet goes
 * straight to making one, for someone who may.
 */
export const automationsIndexRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/",
	component: () => {
		const { bot } = useBotWithHandle(automationsIndexRoute.useParams().bot);
		if (!bot?.permissions.manageAutomations) return null;
		return <MakeFirstAutomation bot={bot} />;
	},
});

function MakeFirstAutomation({ bot }: { bot: Bot }) {
	const { automations } = useListedAutomations(bot);
	if (automations?.length !== 0) return null;
	return <Navigate {...newAutomationLink(bot)} replace />;
}

/**
 * An automation's own page: how it is set up, under its breadcrumb. With
 * `?itemPage=`, one of its runs instead, as a bot's sidebar opens them.
 */
export const automationFeedRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/$automation",
	validateSearch: validateConversationSearch,
	loader: () => ConversationPage.preload(),
	component: () => {
		const { bot: handle, automation } = automationFeedRoute.useParams();
		const { itemPage } = automationFeedRoute.useSearch();
		const { bot } = useBotWithHandle(handle);
		if (!bot) return null;
		// A run is history, which somebody who manages the bot without reaching it does not read.
		return itemPage && bot.permissions.talk ? (
			<AutomationFeed key={automation} bot={bot} automationId={automation} />
		) : (
			<AutomationSetup key={automation} bot={bot} automationId={automation} />
		);
	},
});

/** The automation's feed, opened first when it has none, with the run `?itemPage=` names as the page. */
function AutomationFeed({ bot, automationId }: { bot: Bot; automationId: string }) {
	const opened = useOpenAutomationFeed(bot.id, automationId);
	const navigate = automationFeedRoute.useNavigate();
	const search = automationFeedRoute.useSearch();
	if (opened.isError) {
		return (
			<EmptyState title="Could not open this automation">
				It may have been removed. Reload this page to try again.
			</EmptyState>
		);
	}
	if (!opened.data) return null;
	return (
		<BotConversation
			bot={bot}
			conversationId={opened.data.id}
			search={search}
			navigate={(change) => void navigate(change)}
		/>
	);
}

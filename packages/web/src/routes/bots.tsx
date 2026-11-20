import type { Bot } from "@sugabots/contracts";
import {
	createRoute,
	Link,
	Navigate,
	Outlet,
	useMatchRoute,
	useSearch,
} from "@tanstack/react-router";
import { useBotWithHandle } from "@/lib/bots.ts";
import {
	placeBot,
	prefetchConversation,
	useAnyConversationPlace,
	useBotThreadPlace,
} from "@/lib/chats.ts";
import {
	botAutomationsLink,
	botConnectionsLink,
	botSettingsLink,
	conversationLink,
} from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { FilesPage } from "@/screens/Files.tsx";
import { BotsDirectory } from "@/shell/BotsDirectory.tsx";
import { MobileOwner } from "@/shell/MobileHome.tsx";
import { OwnerNotFound } from "@/shell/OwnerNotFound.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	ConversationPage,
	ConversationScreen,
	preloadChatScreenForWideLayout,
	RoutedConversation,
	type SearchChange,
} from "./conversation.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner } from "./owner.ts";
import {
	type ConversationSearch,
	validateConversationSearch,
	validateFileSearch,
} from "./search.ts";
import { shellRoute } from "./workspace.tsx";

const NewThreadPage = lazyNamed(() => import("@/screens/NewThreadPage.tsx"), "NewThreadPage");

/** Every bot the person reaches, pinning them to the sidebar, and making another. */
export const botsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/bots",
	component: () => (
		<Panes>
			<BotsDirectory />
		</Panes>
	),
});

export const botRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/bots/$bot",
	loader: preloadChatScreenForWideLayout,
	component: BotRoute,
});

/** A bot's page beside the sidebar. */
function BotRoute() {
	const { bot: handle } = botRoute.useParams();
	const { bot, isPending, error } = useBotWithHandle(handle);
	const matchRoute = useMatchRoute();
	const onAutomations = Boolean(
		matchRoute({ to: "/$workspace/bots/$bot/automations", fuzzy: true }),
	);
	const onConnections = Boolean(
		matchRoute({ to: "/$workspace/bots/$bot/connections", fuzzy: true }),
	);
	const onSettings = Boolean(
		matchRoute({ to: "/$workspace/bots/$bot/settings" }) ||
			matchRoute({ to: "/$workspace/bots/$bot/computer" }),
	);
	if (isPending) return <Panes>{null}</Panes>;
	if (!bot) return <OwnerNotFound kind="bot" error={error} />;
	// Someone else's private bot, which an administrator sees listed: it exists, and its settings,
	// connections and automations are theirs to manage, though its threads and what its
	// automations posted are not.
	const managing =
		(bot.permissions.resources.manageAutomations && onAutomations) ||
		(bot.permissions.resources.manageConnections && onConnections) ||
		(bot.permissions.resources.openSettings && onSettings);
	if (!bot.permissions.talk && !managing) {
		return (
			<Panes>
				<EmptyState title={bot.name}>
					<span className="flex flex-col items-center gap-3">
						<span>This is someone else's private bot, so its threads are theirs alone.</span>
						{bot.permissions.update && (
							<Link {...botSettingsLink(bot)} className="text-link underline">
								Open its settings
							</Link>
						)}
						{bot.permissions.resources.manageConnections && (
							<Link {...botConnectionsLink(bot)} className="text-link underline">
								Open its connections
							</Link>
						)}
						{bot.permissions.resources.manageAutomations && (
							<Link {...botAutomationsLink(bot)} className="text-link underline">
								Open its automations
							</Link>
						)}
					</span>
				</EmptyState>
			</Panes>
		);
	}
	return (
		<Panes>
			<Outlet />
		</Panes>
	);
}

/**
 * A bot opened without a thread chosen: on a phone, its sidebar as a page, to
 * pick from, as a project's is; on a wider screen, starting a thread with it
 * from its first message, whether or not it has threads, which are in its
 * sidebar. A project's index opens its newest thread instead.
 */
export const botIndexRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/",
	component: () => {
		const { bot } = useBotWithHandle(botIndexRoute.useParams().bot);
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (!bot) return null;
		return wide ? <BotNewThread bot={bot} /> : <MobileOwner owner={{ bot }} />;
	},
});

/** Starting a thread with the bot, from its first message. */
export const botNewThreadRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/new",
	component: () => {
		const { bot } = useBotWithHandle(botNewThreadRoute.useParams().bot);
		return bot ? <BotNewThread bot={bot} /> : null;
	},
});

/** Starting a thread with `bot` from its first message. */
function BotNewThread({ bot }: { bot: Bot }) {
	return <NewThreadPage key={bot.id} owner={{ bot }} />;
}

/** One of the bot's threads, or one of its automations' feeds. */
export const threadRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/threads/$conversation",
	validateSearch: (search: Record<string, unknown>) => validateConversationSearch(search),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { bot: handle, conversation } = threadRoute.useParams();
		const navigate = threadRoute.useNavigate();
		const search = threadRoute.useSearch();
		const { bot } = useBotWithHandle(handle);
		return bot ? (
			<BotConversation
				bot={bot}
				conversationId={conversation}
				search={search}
				navigate={(change) => void navigate(change)}
			/>
		) : null;
	},
});

/** One of the bot `bot`'s threads or automations' feeds at its own address; see `RoutedConversation`. */
export function BotConversation({
	bot,
	conversationId,
	search,
	navigate,
}: {
	bot: Bot;
	conversationId: string;
	search: ConversationSearch;
	navigate: (change: SearchChange) => void;
}) {
	return (
		<ConversationScreen place={useBotThreadPlace(bot, conversationId)}>
			{(found, user) => (
				<RoutedConversation
					found={found}
					conversationId={conversationId}
					user={user}
					search={search}
					navigate={navigate}
				/>
			)}
		</ConversationScreen>
	);
}

export const botFilesRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/files",
	component: () => {
		const owner = useBotRouteOwner();
		return owner ? <FilesPage owner={owner} /> : null;
	},
});

export const botFileRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const owner = useBotRouteOwner();
		const { file } = botFileRoute.useParams();
		const { version } = botFileRoute.useSearch();
		return owner ? <FilesPage owner={owner} selectedId={file} version={version} /> : null;
	},
});

/** A thread by its id alone, as a notification names it, which goes on to its bot's address. */
export const threadByIdRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/threads/$conversation",
	component: () => {
		const { conversation } = threadByIdRoute.useParams();
		const search = useSearch({ strict: false });
		const { found, isPending, error } = useAnyConversationPlace(conversation);
		if (isPending) return <Panes>{null}</Panes>;
		const bot = found && placeBot(found);
		if (!bot) {
			return (
				<Panes>
					<EmptyState title={error ? "Could not load this thread" : "Thread not found"} />
				</Panes>
			);
		}
		return (
			<Navigate
				{...conversationLink({ bot, conversationId: conversation })}
				search={search as ConversationSearch}
				replace
			/>
		);
	},
});

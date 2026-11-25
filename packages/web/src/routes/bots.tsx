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
import { placeBot, prefetchChat, useAnyChatLocation, useBotChatPlace } from "@/lib/chats.ts";
import { botAutomationsLink, botConnectorsLink, botSettingsLink, chatLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { FilesPage } from "@/screens/Files.tsx";
import { BotsDirectory } from "@/shell/BotsDirectory.tsx";
import { MobileOwner } from "@/shell/MobileHome.tsx";
import { OwnerNotFound } from "@/shell/OwnerNotFound.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	ChatPage,
	ChatScreen,
	preloadChatScreenForWideLayout,
	RoutedChat,
	type SearchChange,
} from "./chat.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner } from "./owner.ts";
import {
	type ChatSearch,
	decodeRouteId,
	validateChatSearch,
	validateFileSearch,
} from "./search.ts";
import { shellRoute } from "./workspace.tsx";

const NewChatPage = lazyNamed(() => import("@/screens/NewChatPage.tsx"), "NewChatPage");

/** Every bot the member reaches, pinning them to the sidebar, and making another. */
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
	const onConnectors = Boolean(matchRoute({ to: "/$workspace/bots/$bot/connectors", fuzzy: true }));
	const onSettings = Boolean(matchRoute({ to: "/$workspace/bots/$bot/settings" }));
	if (isPending) return <Panes>{null}</Panes>;
	if (!bot) return <OwnerNotFound kind="bot" error={error} />;
	// Someone else's personal bot, which an administrator sees listed: it exists, and they may
	// delete it from its settings and pause its automations, though its chats, what its
	// automations posted and the rest of its settings are not theirs.
	const { resources } = bot.permissions;
	const seesAutomations = resources.manageAutomations || resources.pauseAutomations;
	const seesConnectors =
		resources.manageConnectors || (!bot.permissions.talk && resources.openSettings);
	const managing =
		(seesAutomations && onAutomations) ||
		(seesConnectors && onConnectors) ||
		(resources.openSettings && onSettings);
	if (!bot.permissions.talk && !managing) {
		return (
			<Panes>
				<EmptyState
					title={bot.name}
					actions={
						<>
							{resources.openSettings && (
								<Link {...botSettingsLink(bot)} className="text-link underline">
									Open its settings
								</Link>
							)}
							{seesConnectors && (
								<Link {...botConnectorsLink(bot)} className="text-link underline">
									Open its connectors
								</Link>
							)}
							{seesAutomations && (
								<Link {...botAutomationsLink(bot)} className="text-link underline">
									Open its automations
								</Link>
							)}
						</>
					}
				>
					This is someone else's personal bot, so its chats are theirs alone.
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
 * A bot opened without a chat chosen: on a phone, its sidebar as a page, to
 * pick from, as a project's is; on a wider screen, starting a chat with it
 * from its first message, whether or not it has chats, which are in its
 * sidebar. A project's index opens its newest chat instead.
 */
export const botIndexRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/",
	component: () => {
		const { bot } = useBotWithHandle(botIndexRoute.useParams().bot);
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (!bot) return null;
		return wide ? <BotNewChat bot={bot} /> : <MobileOwner owner={{ bot }} />;
	},
});

/** Starting a chat with the bot, from its first message. */
export const botNewChatRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/new",
	component: () => {
		const { bot } = useBotWithHandle(botNewChatRoute.useParams().bot);
		return bot ? <BotNewChat bot={bot} /> : null;
	},
});

/** Starting a chat with `bot` from its first message. */
function BotNewChat({ bot }: { bot: Bot }) {
	return <NewChatPage key={bot.id} owner={{ bot }} />;
}

/** One of the bot's chats, or one of its automations' feeds. */
export const chatRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/chats/$chat",
	params: { parse: ({ chat }) => ({ chat: decodeRouteId(chat) }) },
	validateSearch: (search: Record<string, unknown>) => validateChatSearch(search),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchChat(context.queries, params.chat);
		return ChatPage.preload();
	},
	component: () => {
		const { bot: handle, chat } = chatRoute.useParams();
		const navigate = chatRoute.useNavigate();
		const search = chatRoute.useSearch();
		const { bot } = useBotWithHandle(handle);
		return bot ? (
			<BotChatScreen
				bot={bot}
				chatId={chat}
				search={search}
				navigate={(change) => void navigate(change)}
			/>
		) : null;
	},
});

/** One of the bot `bot`'s chats or automations' feeds at its own address; see `RoutedChat`. */
export function BotChatScreen({
	bot,
	chatId,
	search,
	navigate,
}: {
	bot: Bot;
	chatId: string;
	search: ChatSearch;
	navigate: (change: SearchChange) => void;
}) {
	return (
		<ChatScreen place={useBotChatPlace(bot, chatId)}>
			{(found, signedIn) => (
				<RoutedChat
					found={found}
					chatId={chatId}
					signedIn={signedIn}
					search={search}
					navigate={navigate}
				/>
			)}
		</ChatScreen>
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
	params: { parse: ({ file }) => ({ file: decodeRouteId(file) }) },
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const owner = useBotRouteOwner();
		const { file } = botFileRoute.useParams();
		const { version } = botFileRoute.useSearch();
		return owner ? <FilesPage owner={owner} selectedId={file} version={version} /> : null;
	},
});

/** A chat by its id alone, as a notification names it, which goes on to its bot's address. */
export const chatByIdRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/chats/$chat",
	params: { parse: ({ chat }) => ({ chat: decodeRouteId(chat) }) },
	component: () => {
		const { chat } = chatByIdRoute.useParams();
		const search = useSearch({ strict: false });
		const { found, isPending, error } = useAnyChatLocation(chat);
		if (isPending) return <Panes>{null}</Panes>;
		const bot = found && placeBot(found);
		if (!bot) {
			return (
				<Panes>
					<EmptyState title={error ? "Could not load this chat" : "Chat not found"} />
				</Panes>
			);
		}
		return <Navigate {...chatLink({ bot, chatId: chat })} search={search as ChatSearch} replace />;
	},
});

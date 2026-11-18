import type { Bot } from "@sugabots/contracts";
import { createRoute, Link, Navigate, Outlet, useMatch, useSearch } from "@tanstack/react-router";
import { useBotWithHandle } from "@/lib/bots.ts";
import {
	prefetchConversation,
	useAnyConversationPlace,
	useBotConversationPlace,
} from "@/lib/chats.ts";
import { automationsLink, botSettingsLink, conversationLink } from "@/lib/links.ts";
import { useSession } from "@/lib/session.ts";
import { FilesPage } from "@/screens/Files.tsx";
import { BotsDirectory } from "@/shell/BotsDirectory.tsx";
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
import {
	type ConversationSearch,
	validateConversationSearch,
	validateFileSearch,
} from "./search.ts";
import { shellRoute } from "./workspace.tsx";

const NewTask = lazyNamed(() => import("@/screens/NewTask.tsx"), "NewTask");

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
	const onAutomations =
		useMatch({ from: "/$workspace/bots/$bot/automations", shouldThrow: false }) !== undefined;
	if (isPending) return <Panes>{null}</Panes>;
	if (!bot) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this bot" : "No such bot here"}>
					{error
						? "The API did not answer. Reload, or check that it is running."
						: "It may have been removed or renamed, or it is someone else's private bot."}
				</EmptyState>
			</Panes>
		);
	}
	// Someone else's private bot, which an administrator sees listed: it exists, and its settings
	// and automations are theirs to manage, though its tasks and what its automations posted are not.
	if (!bot.permissions.talk && !(bot.permissions.manageAutomations && onAutomations)) {
		return (
			<Panes>
				<EmptyState title={bot.name}>
					<span className="flex flex-col items-center gap-3">
						<span>This is someone else's private bot, so its tasks are theirs alone.</span>
						{bot.permissions.update && (
							<Link {...botSettingsLink(bot)} className="text-link underline">
								Open its settings
							</Link>
						)}
						{bot.permissions.manageAutomations && (
							<Link {...automationsLink(bot)} className="text-link underline">
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
 * A bot opened without a task chosen: its own page, where something new is
 * asked of it. Its tasks are in its sidebar.
 */
export const botIndexRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/",
	component: () => <BotPage handle={botIndexRoute.useParams().bot} />,
});

/** The bot at `handle`'s own page, starting a task with it from its first message. */
function BotPage({ handle }: { handle: string }) {
	const { bot } = useBotWithHandle(handle);
	const { user } = useSession();
	return bot && user ? <NewTask key={bot.id} bot={bot} userId={user.id} /> : null;
}

/** Starting a task with the bot, from its first message. */
export const newTaskRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/new",
	component: () => <BotPage handle={newTaskRoute.useParams().bot} />,
});

/** One of the bot's tasks, or one of its automations' feeds. */
export const taskRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/tasks/$conversation",
	validateSearch: (search: Record<string, unknown>) => validateConversationSearch(search),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { bot: handle, conversation } = taskRoute.useParams();
		const navigate = taskRoute.useNavigate();
		const search = taskRoute.useSearch();
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

/** One of the bot `bot`'s tasks or automations' feeds at its own address; see `RoutedConversation`. */
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
		<ConversationScreen place={useBotConversationPlace(bot, conversationId)}>
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
		const { bot } = useBotWithHandle(botFilesRoute.useParams().bot);
		return bot ? <FilesPage owner={{ bot }} /> : null;
	},
});

export const botFileRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const { bot: handle, file } = botFileRoute.useParams();
		const { version } = botFileRoute.useSearch();
		const { bot } = useBotWithHandle(handle);
		return bot ? <FilesPage owner={{ bot }} selectedId={file} version={version} /> : null;
	},
});

/** A task by its id alone, as a notification names it, which goes on to its bot's address. */
export const taskByIdRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/tasks/$conversation",
	component: () => {
		const { conversation } = taskByIdRoute.useParams();
		const search = useSearch({ strict: false });
		const { found, isPending, error } = useAnyConversationPlace(conversation);
		if (isPending) return <Panes>{null}</Panes>;
		const bot = found?.conversation.kind === "botConversation" ? found.conversation.bot : undefined;
		if (!bot) {
			return (
				<Panes>
					<EmptyState title={error ? "Could not load this task" : "Task not found"} />
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

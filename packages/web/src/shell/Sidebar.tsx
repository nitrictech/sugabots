import { useRender } from "@base-ui/react/use-render";
import type { Bot, Channel, NotificationSettings, Workspace } from "@sugabots/contracts";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot as BotIcon, ChevronRight, Hash, Library, Plus } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { findBot, useAssistant, useBots, useEnsuredAssistant } from "@/lib/bots.ts";
import { useChannels } from "@/lib/channels.ts";
import { useChannelConversationMarkers } from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import { botsLink, channelsLink, filesLink } from "@/lib/links.ts";
import { useNotificationSettings } from "@/lib/notifications.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { useSession, useSignOut } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { AccountMenu } from "@/shell/AccountMenu.tsx";
import { BotSidebar } from "@/shell/BotSidebar.tsx";
import {
	type BotStanding,
	ChannelConversations,
	NOTHING_NEW,
	SidebarBot,
} from "@/shell/ConversationList.tsx";
import { DirectMessages } from "@/shell/DirectMessages.tsx";
import { HelpMenu } from "@/shell/HelpMenu.tsx";
import { useNewBot } from "@/shell/NewBot.tsx";
import { NewThreadButton } from "@/shell/NewThread.tsx";
import {
	type ChannelStanding,
	NOTHING_NEW_IN_CHANNEL,
	SidebarChannel,
} from "@/shell/SidebarChannel.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";

/** How wide the sidebar is until the viewer drags it, and how narrow it can go, in pixels. */
const SIDEBAR_DEFAULT_WIDTH_PX = 272;
const SIDEBAR_MIN_WIDTH_PX = 216;

/** What the sidebar has open besides the channels and bots, which it shades. */
export type SidebarView = "inbox" | "approvals" | "settings" | "channels" | "bots";

/**
 * The column down the left. While the address is one of a bot's pages (the
 * bot itself, a task, its files or its automations), that bot's own sidebar,
 * `BotSidebar`. Everywhere else: the channels the person is in, each with
 * its conversations, then their bots, the Personal Assistant first and then
 * those they pinned, then their direct messages, and you, Settings and Help at
 * the foot. With `toggleRoom`, its top is left clear for the button that puts
 * it away, which sits over it; without `resizable`, its edge does not drag. A
 * phone has `MobileTabBar` and `MobileHome` instead.
 */
export function Sidebar({
	toggleRoom = false,
	resizable = true,
}: {
	toggleRoom?: boolean;
	resizable?: boolean;
}) {
	const { data: channels } = useChannels();
	const { bots, isPending: botsPending, error: botsError } = useBots();
	const assistant = useAssistant();
	// The sidebar is on every page, hidden on a phone, so this makes it wherever the person lands.
	useEnsuredAssistant(!botsPending && !botsError && !assistant);
	const { data: markers } = useChannelConversationMarkers();
	const { data: notificationSettings } = useNotificationSettings();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	const session = useSession();
	const signOut = useSignOut();
	const place = useSidebarPlace();
	const newBot = useNewBot();
	// Settings opened from a chat leads back to it; opened from settings, it keeps settings' own Back.
	const backToChat = useBackToHere("Chat");
	// A bot's pages have its own sidebar; someone else's private bot, which only lists, has none.
	const botInView = place.botHandle === undefined ? undefined : findBot(bots, place.botHandle);
	const botSidebar = botInView?.permissions.talk ? botInView : undefined;

	return (
		<>
			<SidebarView
				assistant={assistant && { bot: assistant, ...(markers?.bots[assistant.id] ?? NOTHING_NEW) }}
				channels={(channels ?? [])
					.filter((channel) => channel.isMember)
					.map((channel) => ({
						channel,
						...(markers?.channels[channel.id] ?? NOTHING_NEW_IN_CHANNEL),
					}))}
				bots={sidebarBots(bots ?? []).map((bot) => ({
					bot,
					...(markers?.bots[bot.id] ?? NOTHING_NEW),
				}))}
				currentChannelSlug={place.channelSlug}
				currentBotHandle={place.botHandle}
				assistantOpen={place.atHome}
				selectedConversationId={place.conversationId}
				view={place.view}
				workspace={workspace}
				workspaces={workspaces ?? []}
				user={session.user ?? undefined}
				settingsBack={place.inSettings ? undefined : backToChat}
				notificationSettings={notificationSettings}
				onSignOut={() => void signOut()}
				onNewBot={newBot.start}
				toggleRoom={toggleRoom}
				resizable={resizable}
				focus={
					botSidebar && (
						<BotSidebar
							bot={botSidebar}
							userId={session.user?.id}
							selectedConversationId={place.conversationId}
							page={place.botPage}
						/>
					)
				}
				// A phone has its tabs instead, and Home in place of the channels.
				className="max-md:hidden"
				newThread={(channel) => <NewThreadButton channel={channel} />}
				directMessages={
					<DirectMessages
						selectedConversationId={place.directMessageId}
						newMessageOpen={place.newDirectMessage}
					/>
				}
				conversationsOf={(channel) => (
					<ChannelConversations
						channel={channel}
						selectedConversationId={
							channel.slug === place.channelSlug ? place.conversationId : undefined
						}
					/>
				)}
			/>
			{newBot.dialog}
		</>
	);
}

/** The bots the sidebar lists, besides the Personal Assistant: those the person pinned and may use. */
export function sidebarBots(bots: readonly Bot[]): Bot[] {
	return bots.filter(
		(bot) => bot.pinned && !bot.assistant && bot.systemBotKey === null && bot.permissions.talk,
	);
}

/** Where the address is, as the sidebar marks it. */
interface SidebarPlace {
	/** The channel the address is in, if any. */
	channelSlug: string | undefined;
	/** The bot the address is in, if any. */
	botHandle: string | undefined;
	/** Which of the bot's own pages is open, if one is. */
	botPage: "files" | "automations" | undefined;
	/** Whether the workspace's home is open, which is the Personal Assistant's page. */
	atHome: boolean;
	/** The conversation open, if one is. */
	conversationId: string | undefined;
	view: SidebarView | undefined;
	/** The direct message open, if one is. */
	directMessageId: string | undefined;
	/** Whether New message is open, starting a direct message. */
	newDirectMessage: boolean;
	inSettings: boolean;
}

function useSidebarPlace(): SidebarPlace {
	const matchRoute = useMatchRoute();
	const { channel, bot, conversation } = useParams({ strict: false });
	const inSettings = Boolean(matchRoute({ to: "/$workspace/settings", fuzzy: true }));
	const view: SidebarView | undefined = inSettings
		? "settings"
		: matchRoute({ to: "/$workspace/inbox", fuzzy: true })
			? "inbox"
			: matchRoute({ to: "/$workspace/approvals", fuzzy: true })
				? "approvals"
				: matchRoute({ to: "/$workspace/channels" })
					? "channels"
					: matchRoute({ to: "/$workspace/bots" })
						? "bots"
						: undefined;
	return {
		channelSlug: inSettings ? undefined : channel,
		botHandle: inSettings ? undefined : bot,
		botPage: matchRoute({ to: "/$workspace/bots/$bot/files", fuzzy: true })
			? "files"
			: matchRoute({ to: "/$workspace/bots/$bot/automations", fuzzy: true })
				? "automations"
				: undefined,
		atHome: Boolean(matchRoute({ to: "/$workspace" })),
		conversationId: conversation,
		view,
		directMessageId:
			conversation && matchRoute({ to: "/$workspace/dm/$conversation" }) ? conversation : undefined,
		newDirectMessage: Boolean(matchRoute({ to: "/$workspace/dm/new" })),
		inSettings,
	};
}

export function SidebarView({
	assistant,
	channels,
	bots,
	currentChannelSlug,
	currentBotHandle,
	assistantOpen = false,
	selectedConversationId,
	view,
	workspace,
	workspaces = [],
	user,
	settingsBack,
	notificationSettings,
	onSignOut,
	onNewBot,
	toggleRoom = false,
	resizable = true,
	focus,
	className,
	newThread,
	directMessages,
	conversationsOf,
}: {
	/** The viewer's Personal Assistant, once it is there, with how it stands. */
	assistant?: BotStanding;
	/** The channels the viewer is in, with how each stands. */
	channels: readonly ChannelStanding[];
	/** The bots the viewer pinned, with how each stands. */
	bots: readonly BotStanding[];
	/** The channel the page open is in, while it is in one. */
	currentChannelSlug?: string;
	/** The bot the page open is about, while it is about one. */
	currentBotHandle?: string;
	/** Whether the Personal Assistant's page is open as the workspace's home. */
	assistantOpen?: boolean;
	/** The conversation open, while one is. */
	selectedConversationId?: string;
	view: SidebarView | undefined;
	workspace?: Workspace;
	/** Every workspace the viewer belongs to, which your menu offers to switch to. */
	workspaces?: readonly Workspace[];
	user?: { name: string; email: string; image?: string | null };
	/** History state for settings links, so their Back returns to the page they left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	/** What the viewer is notified about, once loaded, which a channel's menu changes. */
	notificationSettings?: NotificationSettings;
	onSignOut: () => void;
	/** Absent when the viewer may not make a bot. */
	onNewBot?: () => void;
	/** Leaves its top clear for the button that puts it away. */
	toggleRoom?: boolean;
	/** Whether its edge drags to change its width. */
	resizable?: boolean;
	/** Shown in place of the channels, bots and direct messages, as a bot's own sidebar is on its pages. */
	focus?: ReactNode;
	className?: string;
	/** What starts a thread in a channel, at the end of its name. */
	newThread?: (channel: Channel) => ReactNode;
	/** The viewer's direct messages, under the bots. */
	directMessages?: ReactNode;
	/** A channel's conversations, over its files. */
	conversationsOf: (channel: Channel) => ReactNode;
}) {
	const [folded, toggleFolded] = useFolded();
	const [width, setWidth] = usePaneWidth("sidebar");
	const nav = useRef<HTMLElement>(null);
	return (
		<nav
			ref={nav}
			aria-label="Sidebar"
			className={cn(
				"@container/sidebar relative flex min-h-0 shrink-0 flex-col bg-rail max-md:flex-1 md:w-(--sidebar-width) md:max-w-100",
				className,
			)}
			style={{ "--sidebar-width": `${width ?? SIDEBAR_DEFAULT_WIDTH_PX}px` } as CSSProperties}
		>
			{resizable && (
				<ResizeHandle
					label="Resize the sidebar"
					pane={nav}
					edge="end"
					min={SIDEBAR_MIN_WIDTH_PX}
					onResize={setWidth}
				/>
			)}
			{toggleRoom && <div aria-hidden className="h-10 shrink-0" />}
			{focus ?? (
				<div
					className={cn(
						"scrollbar-on-hover flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3",
						toggleRoom ? "pt-1" : "pt-3",
					)}
				>
					<FoldSection
						title="Channels"
						open={!folded.has(CHANNELS_FOLD)}
						onToggle={() => toggleFolded(CHANNELS_FOLD)}
						action={
							<IconButton label="Browse channels" size="sm" render={<Link {...channelsLink()} />}>
								<Hash strokeWidth={2.2} />
							</IconButton>
						}
					>
						{channels.map((standing) => {
							const { channel } = standing;
							const current = channel.slug === currentChannelSlug;
							return (
								<SidebarChannel
									key={channel.id}
									standing={standing}
									open={!folded.has(channel.id)}
									holdsSelected={current}
									onToggle={() => toggleFolded(channel.id)}
									settingsBack={settingsBack}
									notificationSettings={notificationSettings}
									newThread={newThread?.(channel)}
								>
									{conversationsOf(channel)}
									<div className="flex flex-col gap-px pt-px pb-px">
										<SidebarLink
											render={<Link {...filesLink({ channel })} />}
											icon={<Library />}
											label="Files"
											selected={current && view === undefined && !selectedConversationId}
										/>
									</div>
								</SidebarChannel>
							);
						})}
						{channels.length === 0 && (
							<SidebarLink
								render={<Link {...channelsLink()} />}
								icon={<Hash />}
								label="Join a channel"
								selected={view === "channels"}
							/>
						)}
					</FoldSection>
					<FoldSection
						title="Bots"
						open={!folded.has(BOTS_FOLD)}
						onToggle={() => toggleFolded(BOTS_FOLD)}
						action={
							<>
								<IconButton label="Browse bots" size="sm" render={<Link {...botsLink()} />}>
									<BotIcon strokeWidth={2.2} />
								</IconButton>
								{onNewBot && (
									<IconButton label="New bot" size="sm" onClick={onNewBot}>
										<Plus strokeWidth={2.2} />
									</IconButton>
								)}
							</>
						}
					>
						<ul className="m-0 flex list-none flex-col gap-px p-0">
							{/* The Personal Assistant always leads. */}
							{assistant && (
								<SidebarBot
									standing={assistant}
									selected={assistantOpen || assistant.bot.handle === currentBotHandle}
									notificationSettings={notificationSettings}
								/>
							)}
							{bots.map((standing) => (
								<SidebarBot
									key={standing.bot.id}
									standing={standing}
									selected={standing.bot.handle === currentBotHandle}
									notificationSettings={notificationSettings}
								/>
							))}
						</ul>
					</FoldSection>
					{directMessages}
				</div>
			)}
			<div className="mt-auto flex items-center gap-1.5 border-border border-t px-3 py-2">
				{user && workspace ? (
					<AccountMenu
						user={user}
						current={workspace}
						workspaces={workspaces}
						settingsBack={settingsBack}
						onSignOut={onSignOut}
					/>
				) : (
					<span className="flex-1" />
				)}
				{workspace && (
					<IconButton
						label="Settings"
						side="top"
						aria-current={view === "settings" ? "page" : undefined}
						render={
							<Link
								to="/$workspace/settings"
								params={{ workspace: workspace.slug }}
								state={settingsBack}
							/>
						}
						className="size-7 rounded-md text-muted-foreground hover:bg-row-hover hover:text-foreground aria-[current=page]:bg-row-selected aria-[current=page]:text-foreground [&_svg]:size-4"
					>
						<SettingsIcon />
					</IconButton>
				)}
				<HelpMenu />
			</div>
		</nav>
	);
}

/** What the sidebar remembers the Channels and Bots headings folded by, beside each channel's id. */
const CHANNELS_FOLD = "channels";
const BOTS_FOLD = "bots";

/**
 * A kind of conversation in the sidebar, beneath a heading that is only its
 * name and folds it away, with a chevron after the name and `action` at its
 * end while the heading is pointed at.
 */
function FoldSection({
	title,
	open,
	onToggle,
	action,
	children,
}: {
	title: string;
	open: boolean;
	onToggle: () => void;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className="flex flex-col gap-px">
			<div className="group/section flex h-8 items-center rounded-sm pr-1.5">
				<h2 className="m-0 flex min-w-0 flex-1 font-normal">
					<button
						type="button"
						aria-expanded={open}
						onClick={onToggle}
						className="focus-ring flex h-8 min-w-0 items-center gap-1 rounded-sm pl-2 text-left"
					>
						<span className="min-w-0 truncate font-medium text-muted-foreground text-xs group-hover/section:text-foreground">
							{title}
						</span>
						<ChevronRight
							aria-hidden
							size={12}
							strokeWidth={2.25}
							className={cn(
								"invisible shrink-0 text-muted-foreground transition-transform group-hover/section:visible group-has-focus-visible/section:visible",
								open && "rotate-90",
							)}
						/>
					</button>
				</h2>
				{action && (
					<span className="flex items-center opacity-0 transition-opacity group-hover/section:opacity-100 group-has-focus-visible/section:opacity-100">
						{action}
					</span>
				)}
			</div>
			{/* Level with the heading, not nested under it. */}
			{open && <div className="flex flex-col gap-px">{children}</div>}
		</section>
	);
}

/** One of the sidebar's places, such as a channel's Files: its icon and name, shaded while it is open, and `end` at its end. */
function SidebarLink({
	render,
	icon,
	label,
	selected,
	end,
}: {
	render: useRender.RenderProp;
	icon: ReactNode;
	label: string;
	selected: boolean;
	end?: ReactNode;
}) {
	return useRender({
		render,
		props: {
			"aria-current": selected ? "page" : undefined,
			className: cn(
				"focus-ring flex h-8 items-center gap-2.5 rounded-sm pr-1.5 pl-2 text-sm transition-colors [&>svg]:mx-px [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-2",
				selected
					? "bg-row-selected text-foreground"
					: "text-muted-foreground hover:bg-row-hover hover:text-foreground",
			),
			children: (
				<>
					{icon}
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{end}
				</>
			),
		},
	});
}

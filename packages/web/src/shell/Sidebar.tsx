import { useRender } from "@base-ui/react/use-render";
import type { Agent, NotificationSettings, Pod, Workspace } from "@sugabots/contracts";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot, Hash, Inbox, Library, Plus, ShieldCheck } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { useAgents, useAssistant, useEnsureAssistant } from "@/lib/agents.ts";
import { useAttentionCounts, usePodChatMarkers } from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import { artifactsLink, botLink, botsLink, channelsLink } from "@/lib/links.ts";
import { useNotificationSettings } from "@/lib/notifications.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { usePods } from "@/lib/pods.ts";
import { useSession, useSignOut } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { AccountMenu } from "@/shell/AccountMenu.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import {
	type BotStanding,
	ChannelConversations,
	SidebarBot,
	sidebarRowClassName,
} from "@/shell/ConversationList.tsx";
import { DirectMessages } from "@/shell/DirectMessages.tsx";
import { HelpMenu } from "@/shell/HelpMenu.tsx";
import { InboxNews } from "@/shell/InboxNews.tsx";
import { NewInPodMenu, useNewBot } from "@/shell/NewInPod.tsx";
import { type PodStanding, SidebarPod } from "@/shell/SidebarPod.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";

/** How wide the sidebar is until the viewer drags it, and how narrow it can go, in pixels. */
const SIDEBAR_DEFAULT_WIDTH_PX = 272;
const SIDEBAR_MIN_WIDTH_PX = 216;

/** What the sidebar has open above the channels and bots, which it shades. */
export type SidebarView = "inbox" | "approvals" | "settings" | "channels" | "bots";

/**
 * The column down the left: the person's Personal Assistant, Inbox and
 * Approvals across the workspace and its Settings, then the channels they
 * are in, each with its conversations, then the bots they pinned, each with
 * its newest tasks, then their direct messages, and you and Help at the foot.
 * A phone has `MobileTabBar` and `MobileHome` instead.
 */
export function Sidebar() {
	const { data: pods } = usePods();
	const { agents, isPending: agentsPending, error: agentsError } = useAgents();
	const assistant = useAssistant();
	useEnsuredAssistant(!agentsPending && !agentsError && !assistant);
	const { data: markers } = usePodChatMarkers();
	const { unreadForYou, unreadInInbox, waitingApprovals } = useAttentionCounts();
	const { data: notificationSettings } = useNotificationSettings();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	const session = useSession();
	const signOut = useSignOut();
	const place = useSidebarPlace();
	const newBot = useNewBot();
	// Settings opened from a chat leads back to it; opened from settings, it keeps settings' own Back.
	const backToChat = useBackToHere("Chat");
	const nothing = { unreadMessages: 0, needsApproval: false, failedRoutines: 0 };

	return (
		<>
			<SidebarView
				assistant={assistant && { agent: assistant, ...(markers?.agents[assistant.id] ?? nothing) }}
				channels={(pods ?? [])
					.filter((pod) => pod.isMember)
					.map((pod) => ({ pod, ...(markers?.pods[pod.id] ?? nothing) }))}
				bots={sidebarBots(agents ?? [], place.botHandle).map((agent) => ({
					agent,
					...(markers?.agents[agent.id] ?? nothing),
				}))}
				currentPodSlug={place.podSlug}
				currentBotHandle={place.botHandle}
				selectedConversationId={place.conversationId}
				view={place.view}
				unreadForYou={unreadForYou}
				unreadInInbox={unreadInInbox}
				waitingApprovals={waitingApprovals}
				workspace={workspace}
				workspaces={workspaces ?? []}
				user={session.user ?? undefined}
				settingsBack={place.inSettings ? undefined : backToChat}
				notificationSettings={notificationSettings}
				onSignOut={() => void signOut()}
				onNewBot={newBot.start}
				// A phone has its tabs instead, and Home in place of the channels.
				className="max-md:hidden"
				newIn={(pod) => <NewInPodMenu pod={pod} />}
				directMessages={
					<DirectMessages
						selectedConversationId={place.directMessageId}
						newMessageOpen={place.newDirectMessage}
					/>
				}
				conversationsOf={(pod) => (
					<ChannelConversations
						pod={pod}
						selectedConversationId={pod.slug === place.podSlug ? place.conversationId : undefined}
					/>
				)}
			/>
			{newBot.dialog}
		</>
	);
}

/**
 * The bots the sidebar lists: those the person pinned and may use, then the
 * one open at `openHandle` while it is open, though not pinned, as an open
 * conversation is listed until it is left.
 */
export function sidebarBots(agents: readonly Agent[], openHandle: string | undefined): Agent[] {
	const listable = (agent: Agent) =>
		!agent.assistant && agent.systemAgentKey === null && agent.permissions.talk;
	const pinned = agents.filter((agent) => agent.pinned && listable(agent));
	const open = agents.find(
		(agent) => agent.handle === openHandle && !agent.pinned && listable(agent),
	);
	return open ? [...pinned, open] : pinned;
}

/** Makes the person's Personal Assistant once, while `missing`. */
export function useEnsuredAssistant(missing: boolean) {
	const { mutate, isIdle } = useEnsureAssistant();
	useEffect(() => {
		if (missing && isIdle) mutate(undefined);
	}, [missing, isIdle, mutate]);
}

/** Where the address is, as the sidebar marks it. */
interface SidebarPlace {
	/** The channel the address is in, if any. */
	podSlug: string | undefined;
	/** The bot the address is in, if any. */
	botHandle: string | undefined;
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
		: matchRoute({ to: "/$workspace/activity", fuzzy: true })
			? "inbox"
			: matchRoute({ to: "/$workspace/approvals", fuzzy: true })
				? "approvals"
				: matchRoute({ to: "/$workspace/channels" })
					? "channels"
					: matchRoute({ to: "/$workspace/bots" })
						? "bots"
						: undefined;
	return {
		podSlug: inSettings ? undefined : channel,
		botHandle: inSettings ? undefined : bot,
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
	currentPodSlug,
	currentBotHandle,
	selectedConversationId,
	view,
	unreadForYou = 0,
	unreadInInbox = 0,
	waitingApprovals = 0,
	workspace,
	workspaces = [],
	user,
	settingsBack,
	notificationSettings,
	onSignOut,
	onNewBot,
	className,
	newIn,
	directMessages,
	conversationsOf,
}: {
	/** The viewer's Personal Assistant, once it is there, with how it stands. */
	assistant?: BotStanding;
	/** The channels the viewer is in, with how each stands. */
	channels: readonly PodStanding[];
	/** The bots the viewer pinned, with how each stands. */
	bots: readonly BotStanding[];
	/** The channel the page open is in, while it is in one. */
	currentPodSlug?: string;
	/** The bot the page open is about, while it is about one. */
	currentBotHandle?: string;
	/** The conversation open, while one is. */
	selectedConversationId?: string;
	view: SidebarView | undefined;
	/**
	 * How many unread messages are written to the viewer, mentioning them or in
	 * their direct messages, which Inbox counts.
	 */
	unreadForYou?: number;
	/** How much in Inbox the viewer has not read, which marks Inbox with a dot while nothing is written to them. */
	unreadInInbox?: number;
	/** How many approvals wait on the viewer, which Approvals counts. */
	waitingApprovals?: number;
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
	className?: string;
	/** What makes a thread in a channel, at the end of its name. */
	newIn?: (pod: Pod) => ReactNode;
	/** The viewer's direct messages, under the bots. */
	directMessages?: ReactNode;
	/** A channel's conversations, under its files. */
	conversationsOf: (pod: Pod) => ReactNode;
}) {
	const [folded, toggleFolded] = useFolded();
	const [width, setWidth] = usePaneWidth("sidebar");
	const nav = useRef<HTMLElement>(null);
	return (
		<nav
			ref={nav}
			aria-label="Sidebar"
			className={cn(
				"@container/sidebar relative flex min-h-0 shrink-0 flex-col border-border border-r bg-rail max-md:flex-1 md:w-(--sidebar-width) md:max-w-100",
				className,
			)}
			style={{ "--sidebar-width": `${width ?? SIDEBAR_DEFAULT_WIDTH_PX}px` } as CSSProperties}
		>
			<ResizeHandle
				label="Resize the sidebar"
				pane={nav}
				edge="end"
				min={SIDEBAR_MIN_WIDTH_PX}
				onResize={setWidth}
			/>
			<div className="flex flex-col gap-px border-border border-b px-3 pt-3 pb-2.5">
				{assistant && (
					<AssistantLink
						assistant={assistant.agent}
						selected={currentBotHandle === assistant.agent.handle}
						attention={assistant.unreadMessages > 0 || assistant.needsApproval}
					/>
				)}
				<SidebarLink
					render={<Link from="/$workspace" to="./activity" />}
					icon={<Inbox />}
					label="Inbox"
					selected={view === "inbox"}
					end={<InboxNews unreadForYou={unreadForYou} unreadInInbox={unreadInInbox} size="md" />}
				/>
				<SidebarLink
					render={<Link from="/$workspace" to="./approvals" />}
					icon={<ShieldCheck />}
					label="Approvals"
					selected={view === "approvals"}
					end={
						waitingApprovals > 0 && (
							<CountBadge
								count={waitingApprovals}
								size="md"
								label={`${waitingApprovals} waiting on you`}
							/>
						)
					}
				/>
				{workspace && (
					<SidebarLink
						render={
							<Link
								to="/$workspace/settings"
								params={{ workspace: workspace.slug }}
								state={settingsBack}
							/>
						}
						icon={<SettingsIcon />}
						label="Settings"
						selected={view === "settings"}
					/>
				)}
			</div>
			<div className="scrollbar-on-hover flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-2.5 pb-3">
				<SidebarSection
					label="Channels"
					action={
						<IconButton label="Browse channels" size="sm" render={<Link {...channelsLink()} />}>
							<Hash strokeWidth={2.2} />
						</IconButton>
					}
				>
					{channels.map((standing) => {
						const { pod } = standing;
						const current = pod.slug === currentPodSlug;
						return (
							<SidebarPod
								key={pod.id}
								standing={standing}
								open={!folded.has(pod.id)}
								holdsSelected={current}
								onToggle={() => toggleFolded(pod.id)}
								settingsBack={settingsBack}
								notificationSettings={notificationSettings}
								newMenu={newIn?.(pod)}
							>
								{conversationsOf(pod)}
								<div className="flex flex-col gap-px pt-px pb-px">
									<SidebarLink
										render={<Link {...artifactsLink({ pod })} />}
										icon={<Library />}
										label="Files"
										selected={current && view === undefined && !selectedConversationId}
									/>
								</div>
							</SidebarPod>
						);
					})}
					<SidebarLink
						render={<Link {...channelsLink()} />}
						icon={<Hash />}
						label={channels.length === 0 ? "Join a channel" : "Browse channels"}
						selected={view === "channels"}
					/>
				</SidebarSection>
				<SidebarSection
					label="Bots"
					action={
						onNewBot && (
							<IconButton label="New bot" size="sm" onClick={onNewBot}>
								<Plus strokeWidth={2.2} />
							</IconButton>
						)
					}
				>
					<ul className="m-0 flex list-none flex-col gap-px p-0">
						{bots.map((standing) => {
							const selected = standing.agent.handle === currentBotHandle;
							return (
								<SidebarBot
									key={standing.agent.id}
									standing={standing}
									open={selected}
									selected={selected}
									selectedConversationId={selected ? selectedConversationId : undefined}
									notificationSettings={notificationSettings}
								/>
							);
						})}
					</ul>
					<SidebarLink
						render={<Link {...botsLink()} />}
						icon={<Bot />}
						label="Browse bots"
						selected={view === "bots"}
					/>
				</SidebarSection>
				{directMessages}
			</div>
			<div className="flex items-center gap-1.5 border-border border-t px-3 py-2">
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
				<HelpMenu />
			</div>
		</nav>
	);
}

/** One of the sidebar's places, such as Inbox: its icon and name, shaded while it is open, and `end` at its end. */
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

/** A part of the sidebar under a heading, such as Channels, with `action` at the heading's end. */
function SidebarSection({
	label,
	action,
	children,
}: {
	label: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="flex flex-col gap-px">
			<div className="group/section flex h-7 items-center pr-1.5 pl-2">
				<h2 className="m-0 min-w-0 flex-1 font-medium text-subtle-foreground text-xs">{label}</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

/** The viewer's Personal Assistant, at the head of the sidebar, bright while it has something new. */
function AssistantLink({
	assistant,
	selected,
	attention,
}: {
	assistant: Agent;
	selected: boolean;
	attention: boolean;
}) {
	return (
		<Link
			{...botLink(assistant)}
			aria-current={selected ? "page" : undefined}
			className={cn(sidebarRowClassName(selected), attention && "font-semibold text-foreground")}
		>
			<AgentAvatar
				color={assistant.color}
				face={assistant.face}
				shape={assistant.shape}
				size={18}
			/>
			<span className="min-w-0 flex-1 truncate">{assistant.name}</span>
		</Link>
	);
}

import { useRender } from "@base-ui/react/use-render";
import type { NotificationSettings, Pod, Workspace } from "@sugabots/contracts";
import { Link, useMatchRoute, useParams, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { Inbox, Library, ShieldCheck } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { useAttentionCounts, usePodChatMarkers } from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import { artifactsLink } from "@/lib/links.ts";
import { useNotificationSettings } from "@/lib/notifications.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { usePods } from "@/lib/pods.ts";
import { useSession, useSignOut } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { AccountMenu } from "@/shell/AccountMenu.tsx";
import { ConversationList, type ListSelection } from "@/shell/ConversationList.tsx";
import { HelpMenu } from "@/shell/HelpMenu.tsx";
import { type PodStanding, SidebarPod } from "@/shell/SidebarPod.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";

/** How wide the sidebar is until the viewer drags it, and how narrow it can go, in pixels. */
const SIDEBAR_DEFAULT_WIDTH_PX = 272;
const SIDEBAR_MIN_WIDTH_PX = 216;

/** What the sidebar has open above the pod's conversations, which it shades. */
export type SidebarView = "inbox" | "approvals" | "settings" | "artifacts" | "routines";

/**
 * The column down the left: Inbox and Approvals across every pod and the
 * workspace's Settings, then each
 * pod in turn, with its artifacts and routines, its chats and its bots, and
 * you and Help at the foot. A phone has `MobileTabBar` and `MobileHome` instead.
 */
export function Sidebar() {
	const { data: pods } = usePods();
	const { data: markers } = usePodChatMarkers();
	const { unreadInInbox, waitingApprovals } = useAttentionCounts();
	const { data: notificationSettings } = useNotificationSettings();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	const session = useSession();
	const signOut = useSignOut();
	const place = useSidebarPlace();
	// Settings opened from a chat leads back to it; opened from settings, it keeps settings' own Back.
	const backToChat = useBackToHere("Chat");
	const current =
		place.podSlug === undefined ? undefined : pods?.find((pod) => pod.slug === place.podSlug);

	return (
		<SidebarView
			pods={[...(pods ?? [])]
				.sort((a, b) => Number(a.kind === "personal") - Number(b.kind === "personal"))
				.map((pod) => ({
					pod,
					unreadMessages: markers?.pods[pod.id]?.unreadMessages ?? 0,
					needsApproval: markers?.pods[pod.id]?.needsApproval ?? false,
					failedRoutines: markers?.pods[pod.id]?.failedRoutines ?? 0,
				}))}
			currentPodId={current?.id}
			view={place.view}
			unreadInInbox={unreadInInbox}
			waitingApprovals={waitingApprovals}
			workspace={workspace}
			workspaces={workspaces ?? []}
			user={session.user ?? undefined}
			settingsBack={place.inSettings ? undefined : backToChat}
			notificationSettings={notificationSettings}
			onSignOut={() => void signOut()}
			// A phone has its tabs instead, and Home in place of the pods.
			className="max-md:hidden"
			conversationsOf={(pod) => (
				<ConversationList
					pod={pod}
					selected={pod.id === current?.id ? place.selected : undefined}
				/>
			)}
		/>
	);
}

/** Where the address is, as the sidebar marks it. */
interface SidebarPlace {
	/** The pod the address is in, if any. */
	podSlug: string | undefined;
	view: SidebarView | undefined;
	selected: ListSelection | undefined;
	inSettings: boolean;
}

function useSidebarPlace(): SidebarPlace {
	const matchRoute = useMatchRoute();
	const { pod, conversation, agent, routine } = useParams({ strict: false });
	// A new thread being started with a bot, by its handle, which keeps that bot open.
	const startingWith = useSearch({
		strict: false,
		select: (search) =>
			matchRoute({ to: "/$workspace/pods/$pod/threads/new" }) ? search.agent : undefined,
	});
	// A bot's Routines page, while none of its routines is open.
	const routinesOf = useSearch({
		strict: false,
		select: (search) =>
			matchRoute({ to: "/$workspace/pods/$pod/routines" }) ? search.bot : undefined,
	});
	const inSettings = Boolean(matchRoute({ to: "/$workspace/settings", fuzzy: true }));
	const view: SidebarView | undefined = inSettings
		? "settings"
		: matchRoute({ to: "/$workspace/activity", fuzzy: true })
			? "inbox"
			: matchRoute({ to: "/$workspace/approvals", fuzzy: true })
				? "approvals"
				: matchRoute({ to: "/$workspace/pods/$pod/artifacts", fuzzy: true })
					? "artifacts"
					: matchRoute({ to: "/$workspace/pods/$pod/routines", fuzzy: true })
						? "routines"
						: undefined;
	return {
		podSlug: pod,
		view,
		selected: matchRoute({ to: "/$workspace/pods/$pod/chat" })
			? { kind: "podChat" }
			: routine
				? { kind: "routine", routineId: routine }
				: routinesOf
					? { kind: "routines", handle: routinesOf }
					: conversation
						? { kind: "conversation", conversationId: conversation }
						: agent && matchRoute({ to: "/$workspace/pods/$pod/agents/$agent" })
							? { kind: "bot", handle: agent }
							: startingWith
								? { kind: "newThread", handle: startingWith }
								: undefined,
		inSettings,
	};
}

export function SidebarView({
	pods,
	currentPodId,
	view,
	unreadInInbox = 0,
	waitingApprovals = 0,
	workspace,
	workspaces = [],
	user,
	settingsBack,
	notificationSettings,
	onSignOut,
	className,
	conversationsOf,
}: {
	/** Every pod the viewer reaches, shared first, then Personal, with how each stands. */
	pods: readonly PodStanding[];
	/** The pod the page open is in, while it is in one. */
	currentPodId: string | undefined;
	view: SidebarView | undefined;
	/** How much in Inbox the viewer has not read, which Inbox counts. */
	unreadInInbox?: number;
	/** How many approvals wait on the viewer, which Approvals counts. */
	waitingApprovals?: number;
	workspace?: Workspace;
	/** Every workspace the viewer belongs to, which your menu offers to switch to. */
	workspaces?: readonly Workspace[];
	user?: { name: string; email: string; image?: string | null };
	/** History state for settings links, so their Back returns to the page they left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	/** What the viewer is notified about, once loaded, which a pod's menu changes. */
	notificationSettings?: NotificationSettings;
	onSignOut: () => void;
	className?: string;
	/** A pod's chats and bots, under its artifacts and routines. */
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
				"@container/sidebar relative flex min-h-0 shrink-0 flex-col border-border border-r bg-rail max-md:flex-1 md:w-(--sidebar-width) md:max-w-[400px]",
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
				<SidebarLink
					render={<Link from="/$workspace" to="./activity" />}
					icon={<Inbox />}
					label="Inbox"
					selected={view === "inbox"}
					end={
						unreadInInbox > 0 && (
							<CountBadge count={unreadInInbox} size="md" label={`${unreadInInbox} unread`} />
						)
					}
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
								className="bg-chip-strong text-muted-foreground"
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
				{pods.map((standing) => {
					const { pod } = standing;
					const current = pod.id === currentPodId;
					return (
						<SidebarPod
							key={pod.id}
							standing={standing}
							open={!folded.has(pod.id)}
							holdsSelected={current}
							onToggle={() => toggleFolded(pod.id)}
							settingsBack={settingsBack}
							notificationSettings={notificationSettings}
						>
							<div className="flex flex-col gap-px pt-px pb-px">
								<SidebarLink
									render={<Link {...artifactsLink(pod)} />}
									icon={<Library />}
									label="Artifacts"
									selected={current && view === "artifacts"}
								/>
							</div>
							{conversationsOf(pod)}
						</SidebarPod>
					);
				})}
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
				"focus-ring flex h-8 items-center gap-2.5 rounded-[6px] pr-1.5 pl-2 text-[14px] transition-colors [&>svg]:mx-px [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-[1.75]",
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

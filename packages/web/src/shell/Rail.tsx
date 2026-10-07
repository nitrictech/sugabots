import type { Agent, Pod, Workspace } from "@sugabots/contracts";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Bell, Hand, Inbox, Plus, UserRound } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useActivityFeed, useApprovalInbox, usePodChatMarkers } from "@/lib/chats.ts";
import { agentChatLink, podLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useSession } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspacePermissions, useWorkspaces } from "@/lib/workspace.ts";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { PodMenuItems } from "@/shell/RailMenus.tsx";
import { WorkspaceSwitcher } from "@/shell/WorkspaceSwitcher.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/dropdown-menu.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** What the rail has open over it: a new pod, or a new bot in a pod. */
type Making = { kind: "pod" } | { kind: "bot"; pod: Pod };

/**
 * The strip down the left edge: the workspace, each shared pod, a way to make one, then Personal, and you at the
 * bottom. Choosing a pod scopes the conversation list
 * beside it.
 */
export function Rail() {
	const { data: pods } = usePods();
	const { data: markers } = usePodChatMarkers();
	const { data: approvals } = useApprovalInbox();
	const { data: activity } = useActivityFeed();
	const { agents } = useAgents();
	const may = useWorkspacePermissions();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	const session = useSession();
	const [making, setMaking] = useState<Making>();
	const navigate = useNavigate();
	const selected = useRailSelection();
	const { agent } = useParams({ strict: false });
	// On a phone an open chat, and settings, take the whole screen, as the design has them.
	const covered = agent !== undefined || selected === "settings";

	return (
		<>
			<RailView
				pods={(pods ?? []).map((pod) => ({
					pod,
					bots: crewIn(agents, pod),
					unreadMessages: markers?.pods[pod.id]?.unreadMessages ?? 0,
					needsApproval: markers?.pods[pod.id]?.needsApproval ?? false,
				}))}
				selected={selected}
				waitingApprovals={approvals?.waiting.length ?? 0}
				unreadMentions={
					activity?.items.filter((item) => item.kind === "mention" && item.unread).length ?? 0
				}
				workspace={workspace}
				workspaces={workspaces ?? []}
				className={covered ? "max-md:hidden" : undefined}
				user={session.user ?? undefined}
				onNewPod={may.createPods ? () => setMaking({ kind: "pod" }) : undefined}
				onNewBot={(pod) => setMaking({ kind: "bot", pod })}
			/>
			<Dialog open={making?.kind === "pod"} onOpenChange={(open) => !open && setMaking(undefined)}>
				<NewPodDialog
					onCreated={async (pod) => {
						setMaking(undefined);
						await navigate(podLink(pod));
					}}
				/>
			</Dialog>
			<Dialog open={making?.kind === "bot"} onOpenChange={(open) => !open && setMaking(undefined)}>
				{making?.kind === "bot" && (
					<NewAgentDialog
						podId={making.pod.id}
						pods={[making.pod]}
						onCreated={async (agent) => {
							setMaking(undefined);
							await navigate(agentChatLink({ pod: making.pod, agent }));
						}}
					/>
				)}
			</Dialog>
		</>
	);
}

export function RailView({
	pods,
	selected,
	waitingApprovals = 0,
	unreadMentions = 0,
	workspace,
	workspaces = [],
	user,
	onNewPod,
	onNewBot,
	className,
}: {
	/**
	 * Every pod the viewer reaches, shared and Personal, with its crew bots, how
	 * many unread messages its chats hold, and whether any waits on the viewer.
	 */
	pods: readonly {
		pod: Pod;
		bots: readonly Agent[];
		unreadMessages?: number;
		needsApproval?: boolean;
	}[];
	/** A pod's slug, `activity`, `approvals`, `settings`, or undefined when none is open. */
	selected: string | undefined;
	/** How many approvals wait on the viewer, which the Approvals tile counts. */
	waitingApprovals?: number;
	/** How many mentions of the viewer are unread, which the Activity tile counts; it counts nothing else new there. */
	unreadMentions?: number;
	/** The workspace being looked at. */
	workspace?: Workspace;
	/** Every workspace the viewer belongs to, which the workspace's menu offers to switch to. */
	workspaces?: readonly Workspace[];
	user?: { name: string; email: string; image?: string | null };
	/** Absent when the viewer may not make a pod. */
	onNewPod?: () => void;
	/** Opens a new bot in the pod whose menu it was chosen from. Offered only where the viewer may add a bot. */
	onNewBot?: (pod: Pod) => void;
	className?: string;
}) {
	const shared = pods.filter(({ pod }) => pod.kind === "shared");
	const personal = pods.find(({ pod }) => pod.kind === "personal");
	// Settings opened from a chat leads back to it; opened from settings, it keeps settings' own Back.
	const backToChat = useBackToHere("Chat");
	const settingsBack = selected === "settings" ? undefined : backToChat;
	const podMenu = (pod: Pod) => (
		<PodMenuItems
			pod={pod}
			settingsBack={settingsBack}
			onNewBot={onNewBot && pod.permissions.createAgents ? () => onNewBot(pod) : undefined}
		/>
	);

	return (
		<nav
			aria-label="Pods"
			className={cn(
				"flex w-16 shrink-0 flex-col items-center gap-3 border-border border-r bg-rail py-4 md:w-[72px]",
				className,
			)}
		>
			{workspace && (
				<>
					<WorkspaceSwitcher
						current={workspace}
						workspaces={workspaces}
						settingsBack={settingsBack}
					/>
					<span aria-hidden className="h-px w-7 shrink-0 bg-border-strong" />
				</>
			)}
			<RailViewTile
				to="./activity"
				label="Activity"
				hint="Mentions, unread messages, routine runs and collaborations from every pod"
				icon={<Bell aria-hidden size={19} strokeWidth={2} />}
				count={unreadMentions}
				selected={selected === "activity"}
			/>
			<RailViewTile
				to="./approvals"
				label="Approvals"
				hint="Bots waiting on your OK"
				icon={<Inbox aria-hidden size={19} strokeWidth={2} />}
				count={waitingApprovals}
				urgent
				selected={selected === "approvals"}
			/>
			<span aria-hidden className="h-px w-7 shrink-0 bg-border-strong" />
			{shared.map(({ pod, bots, unreadMessages, needsApproval }) => (
				<RailItem
					key={pod.id}
					label={pod.name}
					selected={selected === pod.slug}
					pod={pod}
					unreadMessages={unreadMessages}
					needsApproval={needsApproval}
					menu={podMenu(pod)}
				>
					<PodTile bots={bots} color={pod.color} size={44} />
				</RailItem>
			))}

			{onNewPod && (
				<Tooltip label="New pod" side="right">
					<button
						type="button"
						aria-label="New pod"
						onClick={onNewPod}
						className="focus-ring grid size-11 shrink-0 place-items-center rounded-tile border-[1.5px] border-border-dashed border-dashed text-subtle-foreground transition-colors hover:border-disabled-foreground"
					>
						<Plus size={16} strokeWidth={2.2} />
					</button>
				</Tooltip>
			)}

			{personal && (
				<>
					<span aria-hidden className="h-px w-7 shrink-0 bg-border-strong" />
					<RailItem
						label={personal.pod.name}
						selected={selected === personal.pod.slug}
						pod={personal.pod}
						unreadMessages={personal.unreadMessages}
						needsApproval={personal.needsApproval}
						menu={podMenu(personal.pod)}
					>
						{/* A pod like the others, with you on its corner: only you are in it. */}
						<span className="relative">
							<PodTile bots={personal.bots} color={personal.pod.color} size={44} />
							<span
								aria-hidden
								className="absolute -right-[5px] -bottom-[5px] grid size-5 place-items-center rounded-full bg-border-strong text-person-avatar-foreground shadow-[0_0_0_3px_var(--rail)]"
							>
								<UserRound size={10} strokeWidth={2.6} />
							</span>
						</span>
					</RailItem>
				</>
			)}

			<span className="flex-1" />
			{user && (
				<Tooltip label="Settings" side="right">
					<Link
						from="/$workspace"
						to="./settings/$section"
						params={{ section: "profile" }}
						aria-label="Settings"
						aria-current={selected === "settings" ? "page" : undefined}
						className="focus-ring relative flex shrink-0 items-center rounded-full"
					>
						<SelectionBar
							selected={selected === "settings"}
							className="-left-[14px] md:-left-[18px]"
						/>
						<PersonAvatar
							person={user}
							size={36}
							className={cn(
								selected === "settings" &&
									"shadow-[0_0_0_2px_var(--rail),0_0_0_4px_var(--foreground)]",
							)}
						/>
					</Link>
				</Tooltip>
			)}
		</nav>
	);
}

/** Which rail item the address is under: a pod's slug, `activity`, `approvals`, or `settings`, which is you. */
function useRailSelection(): string | undefined {
	const matchRoute = useMatchRoute();
	const { pod } = useParams({ strict: false });
	if (matchRoute({ to: "/$workspace/pods/$pod", fuzzy: true })) return pod;
	if (matchRoute({ to: "/$workspace/activity", fuzzy: true })) return "activity";
	if (matchRoute({ to: "/$workspace/approvals", fuzzy: true })) return "approvals";
	if (matchRoute({ to: "/$workspace/settings", fuzzy: true })) return "settings";
	return undefined;
}

/**
 * A view across every pod, under the workspace's tile: a tile with its name
 * under it, counting what is new there. An `urgent` count fills the tile with
 * the accent, for a decision only the viewer can make.
 */
function RailViewTile({
	to,
	label,
	hint,
	icon,
	count,
	urgent = false,
	selected,
}: {
	to: "./activity" | "./approvals";
	label: string;
	/** What the tooltip says it holds while there is nothing to count. */
	hint: string;
	icon: ReactElement;
	count: number;
	urgent?: boolean;
	selected: boolean;
}) {
	const counted = count > 0;
	const filled = counted && urgent;
	const countWords = urgent
		? `${count} waiting on you`
		: `${count} unread ${count === 1 ? "mention" : "mentions"}`;
	return (
		<Tooltip label={counted ? countWords : hint} side="right">
			<Link
				from="/$workspace"
				to={to}
				aria-label={counted ? `${label}, ${countWords}` : label}
				aria-current={selected ? "page" : undefined}
				className="focus-ring group/view relative flex w-16 shrink-0 flex-col items-center gap-1 rounded-tile"
			>
				<SelectionBar selected={selected} className="top-2 left-0 md:-left-1" />
				<span
					className={cn(
						"relative grid size-11 place-items-center rounded-tile transition-colors",
						filled
							? "bg-primary text-primary-foreground"
							: selected
								? "bg-chip-strong text-foreground"
								: "bg-panel text-muted-foreground group-hover/view:text-soft-foreground",
					)}
				>
					{icon}
					{counted && (
						<CountBadge
							count={count}
							size="lg"
							className={cn(
								"absolute -top-1.5 -right-1.5 shadow-[0_0_0_3px_var(--rail)]",
								filled && "bg-foreground text-background",
							)}
						/>
					)}
				</span>
				<span
					aria-hidden
					className={cn(
						"text-[10.5px]",
						filled || selected
							? "font-semibold text-foreground"
							: "font-medium text-muted-foreground",
					)}
				>
					{label}
				</span>
			</Link>
		</Tooltip>
	);
}

function unreadMessagesWords(count: number): string {
	return count === 1 ? "1 unread message" : `${count} unread messages`;
}

/**
 * What a pod's tile says of its chats, top right: a hand when one waits on the
 * viewer, otherwise how many are unread. Ringed in the rail's colour.
 */
function ChatMarkerBadge({
	unreadMessages,
	needsApproval,
}: {
	unreadMessages: number;
	needsApproval: boolean;
}) {
	if (needsApproval) {
		return (
			<span
				aria-hidden
				className="absolute -top-1.5 -right-1.5 z-10 grid size-[22px] place-items-center rounded-full bg-approval-marker text-white shadow-[0_0_0_3px_var(--rail)]"
			>
				<Hand size={13} strokeWidth={2.4} />
			</span>
		);
	}
	if (unreadMessages === 0) return null;
	return (
		<CountBadge
			count={unreadMessages}
			size="lg"
			className="absolute -top-1.5 -right-1.5 z-10 shadow-[0_0_0_3px_var(--rail)]"
		/>
	);
}

function crewIn(agents: readonly Agent[] | undefined, pod: Pod): Agent[] {
	return agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
}

function RailItem({
	label,
	selected,
	pod,
	unreadMessages = 0,
	needsApproval = false,
	menu,
	children,
}: {
	label: string;
	selected: boolean;
	/** The pod it opens. */
	pod: Pod;
	/** How many unread messages the pod's chats hold, counted on the tile. */
	unreadMessages?: number;
	/** Whether a chat in the pod waits on the viewer, which the tile shows instead of the count. */
	needsApproval?: boolean;
	/** What right-clicking it offers; without it, the browser's own menu. */
	menu?: ReactNode;
	children: ReactElement;
}) {
	const props = {
		"aria-label": needsApproval
			? `${label}, waiting for your approval`
			: unreadMessages > 0
				? `${label}, ${unreadMessagesWords(unreadMessages)}`
				: label,
		"aria-current": selected ? ("page" as const) : undefined,
		className: "focus-ring relative flex shrink-0 items-center rounded-tile",
	};
	const content = (
		<>
			<SelectionBar selected={selected} className="-left-[10px] md:-left-[14px]" />
			<ChatMarkerBadge unreadMessages={unreadMessages} needsApproval={needsApproval} />
			{children}
		</>
	);
	const link = (
		<Link {...podLink(pod)} {...props}>
			{content}
		</Link>
	);
	if (!menu) {
		return (
			<Tooltip label={label} side="right">
				{link}
			</Tooltip>
		);
	}
	return (
		<ContextMenu>
			<Tooltip label={label} side="right">
				<ContextMenuTrigger render={link} />
			</Tooltip>
			<ContextMenuContent className="min-w-48">{menu}</ContextMenuContent>
		</ContextMenu>
	);
}

/** The bar on the rail's left edge beside what is open, which grows in as it is chosen. */
function SelectionBar({ selected, className }: { selected: boolean; className: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"absolute w-1 rounded-r-[3px] bg-foreground transition-[height] duration-150 motion-reduce:transition-none",
				selected ? "h-7" : "h-0",
				className,
			)}
		/>
	);
}

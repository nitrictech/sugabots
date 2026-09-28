import type { Agent, Pod } from "@sugabots/contracts";
import {
	Link,
	useMatchRoute,
	useNavigate,
	useParams,
	useRouteContext,
} from "@tanstack/react-router";
import { cn } from "cn";
import { Lock, Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { agentChatLink, allAgentChatLink, allLink, podLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { AllPodsTile, PodTile } from "@/shell/PodTile.tsx";
import { AllPodsMenuItems, PodMenuItems } from "@/shell/RailMenus.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/ui/dropdown-menu.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** What the rail has open over it: a new pod, or a new bot in a pod or, from All, in one chosen. */
type Making = { kind: "pod" } | { kind: "bot"; pod: Pod | undefined };

/**
 * The strip down the left edge: All, each shared pod, a way to make one, then
 * Personal, and you at the bottom. Choosing a pod scopes the conversation list
 * beside it.
 */
export function Rail() {
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const may = useWorkspacePermissions();
	const { session } = useRouteContext({ from: "__root__" });
	const [making, setMaking] = useState<Making>();
	const navigate = useNavigate();
	const selected = useRailSelection();
	const { agent } = useParams({ strict: false });
	// On a phone an open chat, and settings, take the whole screen, as the design has them.
	const covered = agent !== undefined || selected === "settings";

	return (
		<>
			<RailView
				pods={(pods ?? []).map((pod) => ({ pod, bots: crewIn(agents, pod) }))}
				selected={selected}
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
						podId={making.pod?.id}
						pods={podsToAddBotsTo(pods ?? [])}
						onCreated={async (agent, chosen) => {
							setMaking(undefined);
							const home = making.pod ?? chosen;
							if (!home) return;
							await navigate(
								making.pod
									? agentChatLink({ pod: home, agent })
									: allAgentChatLink({ pod: home, agent }),
							);
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
	user,
	onNewPod,
	onNewBot,
	className,
}: {
	/** Every pod the viewer reaches, shared and Personal, with its crew bots. */
	pods: readonly { pod: Pod; bots: readonly Agent[] }[];
	/** `all`, a pod's slug, `settings`, or undefined when none of them is open. */
	selected: string | undefined;
	user?: { name: string; image?: string | null };
	/** Absent when the viewer may not make a pod. */
	onNewPod?: () => void;
	/**
	 * Opens a new bot in the pod whose menu it was chosen from, or in All's
	 * with `undefined`. Offered only where the viewer may add a bot.
	 */
	onNewBot?: (pod: Pod | undefined) => void;
	className?: string;
}) {
	const shared = pods.filter(({ pod }) => pod.kind === "shared");
	const personal = pods.find(({ pod }) => pod.kind === "personal")?.pod;
	const mayAddBotFromAll = podsToAddBotsTo(shared.map(({ pod }) => pod)).length > 0;
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
	const newBotFromAll = onNewBot && mayAddBotFromAll ? () => onNewBot(undefined) : undefined;
	const allMenu =
		newBotFromAll || onNewPod ? (
			<AllPodsMenuItems onNewBot={newBotFromAll} onNewPod={onNewPod} />
		) : undefined;

	return (
		<nav
			aria-label="Pods"
			className={cn(
				"flex w-16 shrink-0 flex-col items-center gap-3 border-border border-r bg-rail py-[18px] md:w-[76px]",
				className,
			)}
		>
			<RailItem label="All" selected={selected === "all"} menu={allMenu}>
				<AllPodsTile colors={shared.flatMap(({ pod }) => pod.color ?? [])} size={46} />
			</RailItem>
			{shared.map(({ pod, bots }) => (
				<RailItem
					key={pod.id}
					label={pod.name}
					selected={selected === pod.slug}
					pod={pod}
					menu={podMenu(pod)}
				>
					<PodTile bots={bots} color={pod.color} size={46} />
				</RailItem>
			))}

			{onNewPod && (
				<Tooltip label="New pod" side="right">
					<button
						type="button"
						aria-label="New pod"
						onClick={onNewPod}
						className="focus-ring grid size-11 shrink-0 place-items-center rounded-tile border-[1.5px] border-border-dashed border-dashed text-subtle-foreground transition-colors hover:bg-hover md:size-[46px]"
					>
						<Plus size={16} strokeWidth={2.2} />
					</button>
				</Tooltip>
			)}

			{personal && (
				<>
					<span aria-hidden className="h-[1.5px] w-7 shrink-0 rounded-full bg-border-strong" />
					<RailItem
						label={personal.name}
						selected={selected === personal.slug}
						pod={personal}
						menu={podMenu(personal)}
					>
						<span className="grid size-11 place-items-center rounded-tile bg-tile text-soft-foreground md:size-[46px]">
							<Lock size={20} strokeWidth={2} />
						</span>
					</RailItem>
				</>
			)}

			<span className="flex-1" />
			{user && (
				<Tooltip label="Settings" side="right">
					<Link
						from="/$workspace"
						to="./settings"
						aria-label="Settings"
						aria-current={selected === "settings" ? "page" : undefined}
						className="focus-ring relative flex shrink-0 items-center rounded-full"
					>
						<SelectionBar selected={selected === "settings"} className="-left-[14px] md:-left-5" />
						<PersonAvatar
							name={user.name}
							image={user.image}
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

/** Which rail item the address is under: `all`, a pod's slug, or `settings`, which is you. */
function useRailSelection(): string | undefined {
	const matchRoute = useMatchRoute();
	const { pod } = useParams({ strict: false });
	if (matchRoute({ to: "/$workspace/all", fuzzy: true })) return "all";
	if (matchRoute({ to: "/$workspace/pods/$pod", fuzzy: true })) return pod;
	if (matchRoute({ to: "/$workspace/settings", fuzzy: true })) return "settings";
	return undefined;
}

function crewIn(agents: readonly Agent[] | undefined, pod: Pod): Agent[] {
	return agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
}

/** The pods a new bot can go in: shared ones the viewer may add a bot to. */
function podsToAddBotsTo(pods: readonly Pod[]): Pod[] {
	return pods.filter((pod) => pod.kind === "shared" && pod.permissions.createAgents);
}

function RailItem({
	label,
	selected,
	pod,
	menu,
	children,
}: {
	label: string;
	selected: boolean;
	/** The pod it opens; All when there is none. */
	pod?: Pod;
	/** What right-clicking it offers; without it, the browser's own menu. */
	menu?: ReactNode;
	children: ReactElement;
}) {
	const props = {
		"aria-label": label,
		"aria-current": selected ? ("page" as const) : undefined,
		className:
			"focus-ring relative flex shrink-0 items-center rounded-tile [&>span:last-child]:max-md:scale-[0.9565]",
	};
	const content = (
		<>
			<SelectionBar selected={selected} className="-left-[10px] md:-left-[15px]" />
			{children}
		</>
	);
	const link = pod ? (
		<Link {...podLink(pod)} {...props}>
			{content}
		</Link>
	) : (
		<Link {...allLink()} {...props}>
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

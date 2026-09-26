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
import { type ReactElement, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { allLink, podLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

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
	const [creating, setCreating] = useState(false);
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
				onNewPod={may.createPods ? () => setCreating(true) : undefined}
			/>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewPodDialog
					onCreated={async (pod) => {
						setCreating(false);
						await navigate(podLink(pod));
					}}
				/>
			</Dialog>
		</>
	);
}

export function RailView({
	pods,
	selected,
	user,
	onNewPod,
	className,
}: {
	/** Every pod the viewer reaches, shared and Personal, with its crew bots. */
	pods: readonly { pod: Pod; bots: readonly Agent[] }[];
	/** `all`, a pod's slug, `settings`, or undefined when none of them is open. */
	selected: string | undefined;
	user?: { name: string; image?: string | null };
	/** Absent when the viewer may not make a pod. */
	onNewPod?: () => void;
	className?: string;
}) {
	const shared = pods.filter(({ pod }) => pod.kind === "shared");
	const personal = pods.find(({ pod }) => pod.kind === "personal")?.pod;

	return (
		<nav
			aria-label="Pods"
			className={cn(
				"flex w-16 shrink-0 flex-col items-center gap-3 border-border border-r bg-rail py-[18px] md:w-[76px]",
				className,
			)}
		>
			<RailItem label="All" selected={selected === "all"}>
				<PodTile bots={shared.flatMap(({ bots }) => bots.slice(0, 1))} size={46} />
			</RailItem>
			{shared.map(({ pod, bots }) => (
				<RailItem key={pod.id} label={pod.name} selected={selected === pod.slug} pod={pod}>
					<PodTile bots={bots} size={46} />
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
					<RailItem label={personal.name} selected={selected === personal.slug} pod={personal}>
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

function RailItem({
	label,
	selected,
	pod,
	children,
}: {
	label: string;
	selected: boolean;
	/** The pod it opens; All when there is none. */
	pod?: Pod;
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
	return (
		<Tooltip label={label} side="right">
			{pod ? (
				<Link {...podLink(pod)} {...props}>
					{content}
				</Link>
			) : (
				<Link {...allLink()} {...props}>
					{content}
				</Link>
			)}
		</Tooltip>
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

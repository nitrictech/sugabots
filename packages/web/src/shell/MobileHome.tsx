import type { Pod } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Library, Plus, User } from "lucide-react";
import { useState } from "react";
import { usePodChatMarkers } from "@/lib/chats.ts";
import { artifactsLink, podLink, podSettingsLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { ConversationList } from "@/shell/ConversationList.tsx";
import { NewInPodMenu } from "@/shell/NewInPod.tsx";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { Locked, LockGlyph, ONLY_YOU, PERSONAL_POD_PRIVACY } from "@/shell/PersonalPrivacy.tsx";
import { podPalettes } from "@/shell/PodTile.tsx";
import { Dialog } from "@/ui/dialog.tsx";

/**
 * Home on a phone: every pod down a rail at the left, and beside it the one
 * chosen, with its artifacts, then its channels and its bots in one list,
 * each with its threads under it, and a + in its header for a new one.
 */
export function MobileHome({ pod, className }: { pod: Pod; className?: string }) {
	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 bg-background pt-[max(12px,env(safe-area-inset-top))]",
				className,
			)}
		>
			<PodRail currentPodId={pod.id} />
			<section
				aria-label={pod.name}
				className="@container/sidebar flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[20px] bg-list shadow-[inset_1px_1px_0_var(--color-border)]"
			>
				<header className="flex flex-col gap-0.5 pt-[18px] pr-3 pb-3 pl-[18px]">
					<div className="flex items-center gap-2">
						<Link
							{...podSettingsLink(pod)}
							aria-label={`${pod.name} settings`}
							className="focus-ring flex min-w-0 items-center gap-1.5 rounded-md text-foreground"
						>
							<h1 className="m-0 min-w-0 truncate font-semibold text-[22px] tracking-[-0.02em]">
								{pod.name}
							</h1>
							<ChevronRight
								aria-hidden
								size={16}
								strokeWidth={2}
								className="shrink-0 text-subtle-foreground"
							/>
						</Link>
						<span className="flex-1" />
						<NewInPodMenu pod={pod} className="size-9" />
					</div>
					{pod.kind === "personal" && (
						<p className="m-0 flex items-center gap-1.5 text-[13px] text-muted-foreground">
							<LockGlyph size={8} className="shrink-0" />
							{PERSONAL_POD_PRIVACY}
						</p>
					)}
				</header>
				<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-2 pb-4 pl-1.5">
					<Link
						{...artifactsLink(pod)}
						className="focus-ring flex h-11 shrink-0 items-center gap-3 rounded-[10px] px-3 text-[16px] text-muted-foreground active:bg-row-selected"
					>
						<Library aria-hidden size={20} strokeWidth={1.75} className="shrink-0" />
						Artifacts
					</Link>
					<span aria-hidden className="mx-3 h-px shrink-0 bg-border" />
					<ConversationList pod={pod} />
				</div>
			</section>
		</div>
	);
}

/**
 * Every pod the viewer reaches as a tile, shared first, then Personal. A bar
 * at the rail's edge marks the one open, and a short one a pod with something
 * unread. The + at the foot makes a pod, for somebody who may.
 */
function PodRail({ currentPodId }: { currentPodId: string }) {
	const { data: pods } = usePods();
	const { data: markers } = usePodChatMarkers();
	const { createPods } = useWorkspacePermissions();
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const sorted = [...(pods ?? [])].sort(
		(a, b) => Number(a.kind === "personal") - Number(b.kind === "personal"),
	);
	return (
		<nav
			aria-label="Pods"
			className="tab-bar-clearance flex w-[68px] shrink-0 flex-col items-center gap-2.5 overflow-y-auto pt-1.5 pb-4"
		>
			{sorted.map((pod) => {
				const marker = markers?.pods[pod.id];
				const news =
					(marker?.unreadMessages ?? 0) > 0 ||
					marker?.needsApproval === true ||
					(marker?.failedRoutines ?? 0) > 0;
				const current = pod.id === currentPodId;
				const label = [
					pod.name,
					...(pod.kind === "personal" ? [ONLY_YOU] : []),
					...(news ? ["something new"] : []),
				].join(", ");
				return (
					<div key={pod.id} className="relative flex w-full justify-center">
						{(current || news) && (
							<span
								aria-hidden
								className={cn(
									"absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-foreground transition-[height]",
									current ? "h-9" : "h-2",
								)}
							/>
						)}
						<Link
							{...podLink(pod)}
							aria-label={label}
							aria-current={current ? "page" : undefined}
							className="focus-ring rounded-[14px]"
						>
							<RailTile pod={pod} />
						</Link>
					</div>
				);
			})}
			{createPods && (
				<>
					<span aria-hidden className="my-0.5 h-px w-7 shrink-0 bg-border" />
					<button
						type="button"
						aria-label="New pod"
						onClick={() => setCreating(true)}
						className="focus-ring grid size-[46px] shrink-0 place-items-center rounded-2xl bg-chip text-subtle-foreground"
					>
						<Plus aria-hidden size={20} strokeWidth={2} />
					</button>
					<Dialog open={creating} onOpenChange={setCreating}>
						<NewPodDialog
							onCreated={async (pod) => {
								setCreating(false);
								await navigate(podLink(pod));
							}}
						/>
					</Dialog>
				</>
			)}
		</nav>
	);
}

/** A pod's tile in the rail: its initial in its colour on a tint of it, or for Personal a person, locked. */
function RailTile({ pod }: { pod: Pod }) {
	const palette = pod.color === null ? undefined : podPalettes[pod.color];
	const personal = pod.kind === "personal";
	const tile = (
		<span
			aria-hidden
			className={cn(
				"grid size-[46px] place-items-center rounded-[14px] font-semibold text-[18px]",
				!palette && "bg-tile text-foreground",
			)}
			style={palette && { background: palette.tile, color: palette.swatch }}
		>
			{personal ? (
				<User size={20} strokeWidth={2} />
			) : (
				(Array.from(pod.name.trim())[0]?.toUpperCase() ?? "?")
			)}
		</span>
	);
	return personal ? <Locked lockSize={16}>{tile}</Locked> : tile;
}

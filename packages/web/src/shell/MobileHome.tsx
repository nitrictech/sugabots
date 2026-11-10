import type { Pod } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Library, MessageCircle, Plus, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useDirectMessages, usePodChatMarkers } from "@/lib/chats.ts";
import {
	artifactsLink,
	directMessagesLink,
	newDirectMessageLink,
	podLink,
	podSettingsLink,
} from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { ConversationList } from "@/shell/ConversationList.tsx";
import { DirectMessageCards } from "@/shell/DirectMessages.tsx";
import { NewInPodMenu } from "@/shell/NewInPod.tsx";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { Locked, LockGlyph, ONLY_YOU, PERSONAL_POD_PRIVACY } from "@/shell/PersonalPrivacy.tsx";
import { podPalettes } from "@/shell/PodTile.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/** What Home on a phone has open beside its rail: a pod, or the direct messages. */
type HomePlace = { kind: "pod"; podId: string } | { kind: "directMessages" };

/**
 * Home on a phone: the direct messages and every pod down a rail at the
 * left, and beside it the one chosen as `children`, under the name `label`.
 */
function MobileHomeFrame({
	place,
	label,
	className,
	children,
}: {
	place: HomePlace;
	label: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cn("flex min-h-0 flex-1 bg-background pt-safe-or-3", className)}>
			<PodRail place={place} />
			<section
				aria-label={label}
				className="@container/sidebar flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-3xl bg-list inset-ring inset-ring-border"
			>
				{children}
			</section>
		</div>
	);
}

/**
 * Home on a phone with the direct messages open: each one, most recent first,
 * and + to start another.
 */
export function MobileDirectMessages({ className }: { className?: string }) {
	const list = useDirectMessages();
	return (
		<MobileHomeFrame
			place={{ kind: "directMessages" }}
			label="Direct messages"
			className={className}
		>
			<header className="flex items-center gap-2 pt-4.5 pr-3 pb-3 pl-4.5">
				<h1 className="m-0 min-w-0 flex-1 truncate font-semibold text-xl text-foreground tracking-tight">
					Direct messages
				</h1>
				<IconButton label="New message" render={<Link {...newDirectMessageLink()} />}>
					<Plus strokeWidth={2.2} />
				</IconButton>
			</header>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 pb-4 pl-1.5">
				<DirectMessageCards
					items={list.data?.items ?? []}
					status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
				/>
			</div>
		</MobileHomeFrame>
	);
}

/**
 * Home on a phone with a pod open: the pod, with its artifacts, then its
 * channels and its bots in one list, each with its threads under it, and a +
 * in its header for a new one.
 */
export function MobileHome({ pod, className }: { pod: Pod; className?: string }) {
	return (
		<MobileHomeFrame place={{ kind: "pod", podId: pod.id }} label={pod.name} className={className}>
			<header className="flex flex-col gap-0.5 pt-4.5 pr-3 pb-3 pl-4.5">
				<div className="flex items-center gap-2">
					<Link
						{...podSettingsLink(pod)}
						aria-label={`${pod.name} settings`}
						className="focus-ring flex min-w-0 items-center gap-1.5 rounded-md text-foreground"
					>
						<h1 className="m-0 min-w-0 truncate font-semibold text-xl tracking-tight">
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
					<p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
						<LockGlyph size={8} className="shrink-0" />
						{PERSONAL_POD_PRIVACY}
					</p>
				)}
			</header>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-2 pb-4 pl-1.5">
				<Link
					{...artifactsLink(pod)}
					className="focus-ring flex h-11 shrink-0 items-center gap-3 rounded-lg px-3 text-base text-muted-foreground active:bg-row-selected"
				>
					<Library aria-hidden size={20} strokeWidth={1.75} className="shrink-0" />
					Artifacts
				</Link>
				<span aria-hidden className="mx-3 h-px shrink-0 bg-border" />
				<ConversationList pod={pod} />
			</div>
		</MobileHomeFrame>
	);
}

/**
 * The direct messages, then every pod the viewer reaches as a tile, shared
 * first, then Personal. A bar at the rail's edge marks the one open, and a
 * short one any with something unread. The + at the foot makes a pod, for
 * somebody who may.
 */
function PodRail({ place }: { place: HomePlace }) {
	const { data: pods } = usePods();
	const { data: markers } = usePodChatMarkers();
	const { data: directMessages } = useDirectMessages();
	const directNews = directMessages?.items.some((item) => item.unreadMessages > 0) ?? false;
	const { createPods } = useWorkspacePermissions();
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const sorted = [...(pods ?? [])].sort(
		(a, b) => Number(a.kind === "personal") - Number(b.kind === "personal"),
	);
	return (
		<nav
			aria-label="Direct messages and pods"
			className="tab-bar-clearance flex w-17 shrink-0 flex-col items-center gap-2.5 overflow-y-auto pt-1.5 pb-4"
		>
			<RailItem current={place.kind === "directMessages"} news={directNews}>
				<Link
					{...directMessagesLink()}
					aria-label={["Direct messages", ...(directNews ? ["something new"] : [])].join(", ")}
					aria-current={place.kind === "directMessages" ? "page" : undefined}
					className="focus-ring rounded-2xl"
				>
					<span
						aria-hidden
						className="grid size-11.5 place-items-center rounded-2xl bg-tile text-foreground"
					>
						<MessageCircle size={20} strokeWidth={2} />
					</span>
				</Link>
			</RailItem>
			<span aria-hidden className="my-0.5 h-px w-7 shrink-0 bg-border" />
			{sorted.map((pod) => {
				const marker = markers?.pods[pod.id];
				const news =
					(marker?.unreadMessages ?? 0) > 0 ||
					marker?.needsApproval === true ||
					(marker?.failedRoutines ?? 0) > 0;
				const current = place.kind === "pod" && pod.id === place.podId;
				const label = [
					pod.name,
					...(pod.kind === "personal" ? [ONLY_YOU] : []),
					...(news ? ["something new"] : []),
				].join(", ");
				return (
					<RailItem key={pod.id} current={current} news={news}>
						<Link
							{...podLink(pod)}
							aria-label={label}
							aria-current={current ? "page" : undefined}
							className="focus-ring rounded-2xl"
						>
							<RailTile pod={pod} />
						</Link>
					</RailItem>
				);
			})}
			{createPods && (
				<>
					<span aria-hidden className="my-0.5 h-px w-7 shrink-0 bg-border" />
					<button
						type="button"
						aria-label="New pod"
						onClick={() => setCreating(true)}
						className="focus-ring grid size-11.5 shrink-0 place-items-center rounded-2xl bg-chip text-subtle-foreground"
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

/** A place in the rail, `children`, with a bar at the rail's edge while it is open or has something new. */
function RailItem({
	current,
	news,
	children,
}: {
	current: boolean;
	news: boolean;
	children: ReactNode;
}) {
	return (
		<div className="relative flex w-full justify-center">
			{(current || news) && (
				<span
					aria-hidden
					className={cn(
						"absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-foreground transition-all",
						current ? "h-9" : "h-2",
					)}
				/>
			)}
			{children}
		</div>
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
				"grid size-11.5 place-items-center rounded-2xl font-semibold text-lg",
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

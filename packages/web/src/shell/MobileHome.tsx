import { useRender } from "@base-ui/react/use-render";
import type { Pod } from "@sugabots/contracts";
import { FIRST_CHAT_NAME } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronDown, ChevronRight, FileText, Hash, Plus, SquarePen, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList } from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import {
	artifactsLink,
	botPageLink,
	conversationLink,
	newThreadLink,
	podChatLink,
	podLink,
	podSettingsLink,
} from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { crewIn } from "@/shell/ConversationList.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { podPalettes } from "@/shell/PodTile.tsx";
import type { PodStanding } from "@/shell/SidebarPod.tsx";
import { Dialog } from "@/ui/dialog.tsx";

/**
 * Home on a phone: the pods as tiles down the left, the one shown marked
 * with a bar and any with something new with a notch, and beside them the pod
 * shown: its name, which opens its settings, a new thread, its artifacts, its
 * channels and its bots, each bot opening its own page.
 */
export function MobileHome({
	pods,
	pod,
	onNewPod,
}: {
	/** Every pod the viewer reaches, shared first, then Personal, with how each stands. */
	pods: readonly PodStanding[];
	pod: Pod;
	/** Absent when the viewer may not make a pod. */
	onNewPod?: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 pt-[env(safe-area-inset-top)] md:hidden">
			<PodRail pods={pods} current={pod} onNewPod={onNewPod} />
			<PodPanel pod={pod} />
		</div>
	);
}

/** The pods as tiles down the left, then a new one. */
function PodRail({
	pods,
	current,
	onNewPod,
}: {
	pods: readonly PodStanding[];
	current: Pod;
	onNewPod?: () => void;
}) {
	return (
		<nav
			aria-label="Pods"
			className="no-scrollbar flex w-[68px] shrink-0 flex-col items-center gap-2.5 overflow-y-auto pt-3 pb-4"
		>
			{pods.map((standing) => (
				<PodRailTile
					key={standing.pod.id}
					standing={standing}
					current={standing.pod.id === current.id}
				/>
			))}
			<span aria-hidden className="my-0.5 h-px w-7 shrink-0 bg-border" />
			{onNewPod && (
				<button
					type="button"
					onClick={onNewPod}
					aria-label="New pod"
					className="focus-ring grid size-[46px] shrink-0 place-items-center rounded-2xl bg-chip text-subtle-foreground"
				>
					<Plus aria-hidden size={20} strokeWidth={2} />
				</button>
			)}
		</nav>
	);
}

/**
 * A pod's tile, in its colour, with a bar at its left while it is the pod
 * shown and a notch while something in it is new.
 */
function PodRailTile({ standing, current }: { standing: PodStanding; current: boolean }) {
	const { pod, unreadMessages, needsApproval } = standing;
	const news = unreadMessages > 0 || needsApproval;
	const swatch = pod.color === null ? undefined : podPalettes[pod.color].swatch;
	return (
		<div className="relative flex w-[68px] shrink-0 justify-center">
			<span
				aria-hidden
				className={cn(
					"absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-foreground transition-[height]",
					current ? "h-9" : news ? "h-2" : "h-0",
				)}
			/>
			<Link
				{...podLink(pod)}
				aria-label={pod.name}
				aria-current={current ? "page" : undefined}
				className={cn(
					"focus-ring grid size-[46px] place-items-center rounded-[14px] font-semibold text-[18px]",
					!swatch && "bg-chip text-foreground",
				)}
				style={
					swatch
						? { background: `color-mix(in oklab, ${swatch} 20%, transparent)`, color: swatch }
						: undefined
				}
			>
				{pod.kind === "personal" ? (
					<User aria-hidden size={20} strokeWidth={2} />
				) : (
					(Array.from(pod.name.trim())[0]?.toUpperCase() ?? "?")
				)}
				{news && <span className="sr-only">, something new</span>}
			</Link>
		</div>
	);
}

/** The pod shown: its name and a new thread, then its artifacts, channels and bots. */
function PodPanel({ pod }: { pod: Pod }) {
	const list = useChatList(pod.slug);
	const { agents } = useAgents();
	const [folded, toggleFolded] = useFolded();
	const [addingBot, setAddingBot] = useState(false);
	const navigate = useNavigate();
	const bots = crewIn(agents, pod);
	const threads = list.data?.threads ?? [];
	const chats = list.data?.chats ?? [];
	const channelsKey = `chats:${pod.id}`;
	const botsKey = `bots:${pod.id}`;
	return (
		<section
			aria-label={pod.name}
			className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[20px] bg-list shadow-[inset_1px_1px_0_var(--color-border)]"
		>
			<div className="flex items-center gap-2 pt-[18px] pr-3 pb-3 pl-[18px]">
				<Link
					{...podSettingsLink(pod)}
					className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-foreground"
				>
					<span className="min-w-0 truncate font-semibold text-[22px] tracking-[-0.02em]">
						{pod.name}
					</span>
					<ChevronRight
						aria-hidden
						size={16}
						strokeWidth={2}
						className="shrink-0 text-subtle-foreground"
					/>
				</Link>
				<Link
					{...newThreadLink(pod)}
					aria-label="New thread"
					className="focus-ring grid size-9 shrink-0 place-items-center rounded-full bg-chip text-foreground"
				>
					<SquarePen aria-hidden size={17} strokeWidth={1.75} />
				</Link>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 pb-4 pl-1.5">
				<Row render={<Link {...artifactsLink(pod)} />} icon={<FileText />} label="Artifacts" />
				<span aria-hidden className="mx-3 mt-2.5 h-px shrink-0 bg-border" />
				{pod.kind === "shared" && (
					<>
						<Heading
							label="Channels"
							open={!folded.has(channelsKey)}
							onToggle={() => toggleFolded(channelsKey)}
						/>
						{!folded.has(channelsKey) &&
							(chats.length === 0 ? (
								<Row
									render={<Link {...podChatLink(pod)} />}
									icon={<Hash />}
									label={FIRST_CHAT_NAME}
								/>
							) : (
								chats.map((chat) => (
									<Row
										key={chat.conversation.id}
										render={
											<Link {...conversationLink({ pod, conversationId: chat.conversation.id })} />
										}
										icon={<Hash />}
										label={chat.conversation.title}
										unread={chat.unreadMessages > 0}
									/>
								))
							))}
					</>
				)}
				<Heading label="Bots" open={!folded.has(botsKey)} onToggle={() => toggleFolded(botsKey)} />
				{!folded.has(botsKey) && (
					<>
						{bots.map((bot) => {
							const ofBot = threads.filter(
								(row) => row.agent?.id === bot.id && row.conversation.doneAt === null,
							);
							return (
								<Row
									key={bot.id}
									render={<Link {...botPageLink(pod, bot)} />}
									icon={
										<AgentAvatar color={bot.color} face={bot.face} shape={bot.shape} size={22} />
									}
									label={bot.name}
									unread={ofBot.some((row) => row.unreadMessages > 0 || row.needsApproval)}
									end={
										ofBot.length > 0 && (
											<span className="text-[13px] text-subtle-foreground tabular-nums">
												{ofBot.length}
											</span>
										)
									}
								/>
							);
						})}
						{pod.permissions.createAgents && (
							<Row
								render={<button type="button" onClick={() => setAddingBot(true)} />}
								icon={
									<span className="grid size-[22px] place-items-center rounded-md shadow-[inset_0_0_0_1px_var(--color-border-dashed)]">
										<Plus size={12} strokeWidth={2.25} />
									</span>
								}
								label="Add a bot"
								quiet
							/>
						)}
					</>
				)}
			</div>
			<Dialog open={addingBot} onOpenChange={setAddingBot}>
				<NewAgentDialog
					podId={pod.id}
					pods={[pod]}
					onCreated={async (agent) => {
						setAddingBot(false);
						await navigate(botPageLink(pod, agent));
					}}
				/>
			</Dialog>
		</section>
	);
}

/** A section's name, which folds it away or opens it. */
function Heading({
	label,
	open,
	onToggle,
}: {
	label: string;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="focus-ring mt-2.5 flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-left font-medium text-[14px] text-subtle-foreground"
		>
			{label}
			<ChevronDown
				aria-hidden
				size={14}
				strokeWidth={2}
				className={cn("transition-transform", !open && "-rotate-90")}
			/>
		</button>
	);
}

/**
 * A row of the pod: its mark and name, bright and notched at its left while
 * something there is new, and `end` at its end.
 */
function Row({
	render,
	icon,
	label,
	unread = false,
	quiet = false,
	end,
}: {
	render: useRender.RenderProp;
	icon: ReactNode;
	label: string;
	unread?: boolean;
	/** A row that offers something rather than opening it, greyer. */
	quiet?: boolean;
	end?: ReactNode;
}) {
	return useRender({
		render,
		props: {
			className: cn(
				"focus-ring relative flex h-11 shrink-0 items-center gap-3 rounded-[10px] px-3 text-left text-[16px] active:bg-chip [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:stroke-[1.75]",
				unread
					? "font-semibold text-foreground"
					: quiet
						? "text-subtle-foreground"
						: "text-muted-foreground",
			),
			children: (
				<>
					{unread && (
						<span
							aria-hidden
							className="absolute top-1/2 -left-1.5 h-2 w-1 -translate-y-1/2 rounded-r bg-foreground"
						/>
					)}
					{icon}
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{unread && <span className="sr-only">, unread</span>}
					{end}
				</>
			),
		},
	});
}

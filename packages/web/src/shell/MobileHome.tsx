import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot, Hash, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useAgents, useAssistant } from "@/lib/agents.ts";
import { useDirectMessages, usePodChatMarkers } from "@/lib/chats.ts";
import { botLink, botsLink, channelsLink, newDirectMessageLink, podLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import {
	ChannelConversations,
	SidebarBot,
	sidebarRowClassName,
} from "@/shell/ConversationList.tsx";
import { DirectMessageCards } from "@/shell/DirectMessages.tsx";
import { sidebarBots, useEnsuredAssistant } from "@/shell/Sidebar.tsx";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/** A page of Home on a phone, under its title, with `action` beside it. */
function MobilePage({
	title,
	action,
	className,
	children,
}: {
	title: string;
	action?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className={cn(
				"@container/sidebar flex min-h-0 min-w-0 flex-1 flex-col bg-list pt-safe-or-3",
				className,
			)}
		>
			<header className="flex items-center gap-2 pt-4.5 pr-3 pb-3 pl-4.5">
				<h1 className="m-0 min-w-0 flex-1 truncate font-semibold text-xl text-foreground tracking-tight">
					{title}
				</h1>
				{action}
			</header>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2 pb-4 pl-1.5">
				{children}
			</div>
		</section>
	);
}

/**
 * Home on a phone with the direct messages open: each one, most recent first,
 * and + to start another.
 */
export function MobileDirectMessages({ className }: { className?: string }) {
	const list = useDirectMessages();
	return (
		<MobilePage
			title="Direct messages"
			className={className}
			action={
				<IconButton label="New message" render={<Link {...newDirectMessageLink()} />}>
					<Plus strokeWidth={2.2} />
				</IconButton>
			}
		>
			<DirectMessageCards
				items={list.data?.items ?? []}
				status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
			/>
		</MobilePage>
	);
}

/**
 * Home on a phone: the Personal Assistant, the channels the person is in,
 * each with its conversations, and the bots they pinned.
 */
export function MobileHome({ className }: { className?: string }) {
	const { data: pods } = usePods();
	const { agents, isPending, error } = useAgents();
	const assistant = useAssistant();
	useEnsuredAssistant(!isPending && !error && !assistant);
	const { data: markers } = usePodChatMarkers();
	const nothing = { unreadMessages: 0, needsApproval: false, failedRoutines: 0 };
	const pinned = sidebarBots(agents ?? [], undefined);
	return (
		<MobilePage title="Home" className={className}>
			{assistant && (
				<Link {...botLink(assistant)} className={sidebarRowClassName(false)}>
					<AgentAvatar
						color={assistant.color}
						face={assistant.face}
						shape={assistant.shape}
						size={22}
					/>
					<span className="min-w-0 flex-1 truncate">{assistant.name}</span>
				</Link>
			)}
			<HomeSection label="Channels">
				{pods
					?.filter((pod) => pod.isMember)
					.map((pod) => (
						<div key={pod.id} className="flex flex-col gap-px">
							<Link {...podLink(pod)} className={sidebarRowClassName(false)}>
								<PodInitial pod={pod} />
								<span className="min-w-0 flex-1 truncate font-medium">{pod.name}</span>
							</Link>
							<div className="pl-4">
								<ChannelConversations pod={pod} />
							</div>
						</div>
					))}
				<Link {...channelsLink()} className={sidebarRowClassName(false)}>
					<Hash aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
					Browse channels
				</Link>
			</HomeSection>
			<HomeSection label="Bots">
				<ul className="m-0 flex list-none flex-col gap-px p-0">
					{pinned.map((agent) => (
						<SidebarBot
							key={agent.id}
							standing={{ agent, ...(markers?.agents[agent.id] ?? nothing) }}
							open={false}
							selected={false}
						/>
					))}
				</ul>
				<Link {...botsLink()} className={sidebarRowClassName(false)}>
					<Bot aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
					Browse bots
				</Link>
			</HomeSection>
		</MobilePage>
	);
}

function HomeSection({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section aria-label={label} className="flex flex-col gap-px">
			<h2 className="m-0 px-3 pb-1 font-medium text-subtle-foreground text-xs">{label}</h2>
			{children}
		</section>
	);
}

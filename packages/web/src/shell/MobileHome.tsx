import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot, Hash, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useAssistant, useBots } from "@/lib/bots.ts";
import { useChannels } from "@/lib/channels.ts";
import { useChannelConversationMarkers, useDirectMessages } from "@/lib/chats.ts";
import { botLink, botsLink, channelLink, channelsLink, newDirectMessageLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import {
	ChannelConversations,
	SidebarBot,
	sidebarRowClassName,
} from "@/shell/ConversationList.tsx";
import { DirectMessageCards } from "@/shell/DirectMessages.tsx";
import { sidebarBots, useEnsuredAssistant } from "@/shell/Sidebar.tsx";
import { ChannelInitial } from "@/shell/SidebarChannel.tsx";
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
	const { data: channels } = useChannels();
	const { bots, isPending, error } = useBots();
	const assistant = useAssistant();
	useEnsuredAssistant(!isPending && !error && !assistant);
	const { data: markers } = useChannelConversationMarkers();
	const nothing = { unreadMessages: 0, needsApproval: false, failedAutomations: 0 };
	const pinned = sidebarBots(bots ?? [], undefined);
	return (
		<MobilePage title="Home" className={className}>
			{assistant && (
				<Link {...botLink(assistant)} className={sidebarRowClassName(false)}>
					<BotAvatar
						color={assistant.color}
						face={assistant.face}
						shape={assistant.shape}
						size={22}
					/>
					<span className="min-w-0 flex-1 truncate">{assistant.name}</span>
				</Link>
			)}
			<HomeSection label="Channels">
				{channels
					?.filter((channel) => channel.isMember)
					.map((channel) => (
						<div key={channel.id} className="flex flex-col gap-px">
							<Link {...channelLink(channel)} className={sidebarRowClassName(false)}>
								<ChannelInitial channel={channel} />
								<span className="min-w-0 flex-1 truncate font-medium">{channel.name}</span>
							</Link>
							<div className="pl-4">
								<ChannelConversations channel={channel} />
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
					{pinned.map((bot) => (
						<SidebarBot
							key={bot.id}
							standing={{ bot, ...(markers?.bots[bot.id] ?? nothing) }}
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

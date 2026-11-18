import type { LivelyFace } from "@sugabots/avatars";
import {
	type Bot,
	type Channel,
	type ChatList,
	FIRST_CHAT_NAME,
	type NotificationSettings,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleAlert, Hash } from "lucide-react";
import { useRef } from "react";
import { useModels } from "@/lib/bots.ts";
import { useChatList } from "@/lib/chats.ts";
import { botLink, channelLink, conversationLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { TurnTakingAvatar } from "@/shell/Bot.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** One of a channel's conversations in its list: its main chat or a thread. */
type ListedChat = ChatList["chats"][number];

/**
 * A channel's conversations in the sidebar: its main chat first, listed
 * before anyone opens it, which opens it, then its threads.
 */
export function ChannelConversations({
	channel,
	selectedConversationId,
}: {
	channel: Channel;
	selectedConversationId?: string;
}) {
	const list = useChatList(channel.slug);
	return (
		<ChannelConversationsView
			channel={channel}
			chats={list.data?.chats ?? []}
			status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
			selectedConversationId={selectedConversationId}
		/>
	);
}

export function ChannelConversationsView({
	channel,
	chats,
	status,
	selectedConversationId,
}: {
	channel: Channel;
	/** Its main chat first, none until somebody opens it, then its threads. */
	chats: readonly ListedChat[];
	status: "loading" | "ready" | "failed";
	selectedConversationId?: string;
}) {
	const shown: (ListedChat | "unopened")[] = chats.some((chat) => chat.conversation.main)
		? [...chats]
		: ["unopened", ...chats];
	return (
		<div className="flex flex-col gap-px">
			{status === "failed" && (
				<p className="m-0 px-2 pb-4 text-xs text-muted-foreground">Could not load these threads.</p>
			)}
			<ul className="m-0 flex list-none flex-col gap-px p-0">
				{shown.map((chat) => (
					<li key={chat === "unopened" ? "unopened" : chat.conversation.id}>
						<ChannelConversationRow
							channel={channel}
							chat={chat}
							selected={chat !== "unopened" && chat.conversation.id === selectedConversationId}
						/>
					</li>
				))}
			</ul>
		</div>
	);
}

/** A row of the sidebar: a link or button 32px tall, or 44px for a thumb on a phone, shaded while it is the one open. */
export function sidebarRowClassName(selected: boolean): string {
	return cn(
		"focus-ring flex h-8 min-w-0 items-center gap-2.5 rounded-sm pr-1.5 pl-2 text-sm transition-colors",
		PHONE_ROW,
		selected
			? "bg-row-selected text-foreground"
			: "text-muted-foreground hover:bg-row-hover hover:text-foreground",
	);
}

/** One of the channel's conversations, bright and dotted while something there is new. */
function ChannelConversationRow({
	channel,
	chat,
	selected,
}: {
	channel: Channel;
	chat: ListedChat | "unopened";
	selected: boolean;
}) {
	const unreadMessages = chat === "unopened" ? 0 : chat.unreadMessages;
	const hideSidebar = useHideSidebar();
	return (
		<Link
			onDoubleClick={hideSidebar}
			{...(chat === "unopened"
				? channelLink(channel)
				: conversationLink({ channel, conversationId: chat.conversation.id }))}
			aria-current={selected ? "page" : undefined}
			className={sidebarRowClassName(selected)}
		>
			<Hash aria-hidden size={16} strokeWidth={1.75} className="mx-px shrink-0" />
			<span
				className={cn(
					"min-w-0 flex-1 truncate-fade",
					unreadMessages > 0 && "font-semibold text-foreground",
				)}
			>
				{chat === "unopened" ? FIRST_CHAT_NAME : chat.conversation.title}
			</span>
			<span className={END_SLOT}>
				<UnreadMarker unreadMessages={unreadMessages} needsYou={false} />
			</span>
		</Link>
	);
}

/** How a bot stands for the viewer, as the sidebar marks it. */
export interface BotStanding {
	bot: Bot;
	/** How many unread messages its tasks and automations' feeds hold. */
	unreadMessages: number;
	/** Whether one of its conversations waits on the viewer. */
	needsApproval: boolean;
	/** How many of its automations failed their latest run. */
	failedAutomations: number;
}

/** How a bot stands while the sidebar's markers have nothing for it, or have not loaded. */
export const NOTHING_NEW = { unreadMessages: 0, needsApproval: false, failedAutomations: 0 };

/** A row's height and type on a phone, where a thumb taps it rather than a pointer, shaded while pressed. */
const PHONE_ROW =
	"max-md:h-11 max-md:gap-3 max-md:rounded-lg max-md:text-base max-md:active:bg-row-selected";

/**
 * A bot on one line, which opens its page, where a task with it starts. At its
 * end, what is new in it, and beside that an alert while something is wrong
 * that its settings or automations set right. Right-clicked, it offers its
 * notifications.
 */
export function SidebarBot({
	standing,
	selected,
	notificationSettings,
}: {
	standing: BotStanding;
	/** Whether the bot's page is the one open. */
	selected: boolean;
	notificationSettings?: NotificationSettings;
}) {
	const { bot, unreadMessages, needsApproval, failedAutomations } = standing;
	const face = useRef<LivelyFace>(null);
	const hideSidebar = useHideSidebar();
	const models = useModels().data?.models;
	const problem = botProblem(bot, models, failedAutomations);
	const attention = unreadMessages > 0 || needsApproval;
	const notificationPlace = { kind: "bot", id: bot.id } as const;
	return (
		<li className="flex flex-col">
			<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
				<Link
					{...botLink(bot)}
					aria-current={selected ? "page" : undefined}
					onDoubleClick={hideSidebar}
					onPointerEnter={() => face.current?.play("hop")}
					className={cn(sidebarRowClassName(selected), attention && "text-foreground")}
				>
					<TurnTakingAvatar bot={bot} size={18} faceRef={face} className="shrink-0" />
					<span className={cn("min-w-0 flex-1 truncate-fade", attention && "font-semibold")}>
						{bot.name}
					</span>
					<MutedMark settings={notificationSettings} place={notificationPlace} />
					{(attention || problem) && (
						<span className={cn(END_SLOT, problem && attention && "w-auto gap-1.5")}>
							{/* Read after its name, as a row reads what waits in it. */}
							<span className="sr-only">, </span>
							<UnreadMarker unreadMessages={unreadMessages} needsYou={needsApproval} />
							{problem && (
								<Tooltip label={problem} side="right">
									<CircleAlert
										role="img"
										aria-label={problem}
										size={14}
										strokeWidth={2}
										className="shrink-0 text-destructive-text"
									/>
								</Tooltip>
							)}
						</span>
					)}
				</Link>
			</NotificationsContextMenu>
		</li>
	);
}

/**
 * What is wrong with `bot` that its own pages set right, for its row: no
 * model, or one since switched off, which its settings fix; or an automation
 * whose latest run failed, which its Automations show.
 */
export function botProblem(
	bot: Bot,
	models: readonly { modelId: string }[] | undefined,
	failedAutomations: number,
): string | undefined {
	if (bot.model === null) return "No model chosen";
	if (models && !models.some((model) => model.modelId === bot.model)) {
		return "This model is no longer switched on for the workspace";
	}
	if (failedAutomations > 0) return "An automation's last run failed";
	return undefined;
}

/** How far a part of the sidebar sits in from what holds it: less while the sidebar is narrow, to leave names room. */
export const NESTED_INDENT = "pl-1.5 @[248px]/sidebar:pl-3";

/**
 * The end of a sidebar row, as wide as the + beside a section's name, so a
 * row's dot, its +, and the section's + all line up.
 */
export const END_SLOT = "grid w-5.5 shrink-0 place-items-center";

/**
 * At a row's end: a dot while it waits on the viewer, as a decision or a
 * mention does. Unread messages show in the row's bold name, so they are only
 * counted for a screen reader.
 */
export function UnreadMarker({
	unreadMessages,
	needsYou,
}: {
	unreadMessages: number;
	needsYou: boolean;
}) {
	const unread = unreadMessages > 0 && countOf(unreadMessages, "unread message", "unread messages");
	if (!needsYou) return unread ? <span className="sr-only">{unread}</span> : null;
	const label = unread ? `${unread}, needs you` : "Needs you";
	return (
		<Tooltip label={label} side="right">
			<span className="size-1.5 rounded-full bg-foreground">
				<span className="sr-only">{label}</span>
			</span>
		</Tooltip>
	);
}

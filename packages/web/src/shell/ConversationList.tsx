import { type LivelyFace, LivelyGroup } from "@sugabots/avatars";
import {
	type Bot,
	type Channel,
	type ChatList,
	type ChatListItem,
	FIRST_CHAT_NAME,
	type NotificationSettings,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronRight, Hash, Plus, Zap } from "lucide-react";
import { useRef } from "react";
import { useBotTasks, useChatList } from "@/lib/chats.ts";
import {
	automationsLink,
	botLink,
	conversationLink,
	mainChatLink,
	newTaskLink,
} from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { TASKS_SHOWN } from "@/lib/screen-limits.ts";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { TurnTakingAvatar } from "@/shell/Bot.tsx";
import { FailedDot } from "@/shell/FailedDot.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** One of a channel's conversations in its list: its main chat or a thread. */
export type ListedChat = ChatList["chats"][number];

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
	return (
		<Link
			{...(chat === "unopened"
				? mainChatLink(channel)
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

/** A row's height and type on a phone, where a thumb taps it rather than a pointer, shaded while pressed. */
const PHONE_ROW =
	"max-md:h-11 max-md:gap-3 max-md:rounded-lg max-md:text-base max-md:active:bg-row-selected";

/** A bot's own part of its row: its face and name, filling the row up to its end. */
const botClassName =
	"focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm pl-2 text-left text-sm max-md:gap-3 max-md:rounded-lg max-md:text-base";

/**
 * A bot on one line, which opens it, with its newest open tasks under it
 * while `open`. At its end, what is new in it, or a red dot while one of its
 * automations failed; under the pointer, a + that starts a new task with it.
 * Right-clicked, it offers its notifications.
 */
export function SidebarBot({
	standing,
	open,
	selected,
	selectedConversationId,
	notificationSettings,
}: {
	standing: BotStanding;
	/** Whether its tasks are listed under it: while it, or something of it, is the page open. */
	open: boolean;
	/** Whether the bot itself, or something of it, is the page open. */
	selected: boolean;
	selectedConversationId?: string;
	notificationSettings?: NotificationSettings;
}) {
	const { bot, unreadMessages, needsApproval, failedAutomations } = standing;
	const face = useRef<LivelyFace>(null);
	const attention = unreadMessages > 0 || needsApproval;
	const endMark =
		attention || failedAutomations > 0 ? (
			<>
				<UnreadMarker unreadMessages={unreadMessages} needsYou={needsApproval} />
				{failedAutomations > 0 &&
					(needsApproval ? (
						<span className="sr-only">, latest automation run failed</span>
					) : (
						<FailedDot />
					))}
			</>
		) : undefined;
	const notificationPlace = { kind: "bot", id: bot.id } as const;
	const row = (
		<div
			onPointerEnter={() => face.current?.play("hop")}
			className={cn(
				"group/bot relative flex h-8 items-center rounded-sm pr-1.5 max-md:h-11 max-md:rounded-lg max-md:active:bg-row-selected",
				selected && !open ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<Link
				{...botLink(bot)}
				aria-current={selected && !selectedConversationId ? "page" : undefined}
				className={cn(
					botClassName,
					attention || selected
						? "text-foreground"
						: "text-muted-foreground group-hover/bot:text-foreground",
				)}
			>
				<TurnTakingAvatar bot={bot} size={18} faceRef={face} className="shrink-0" />
				<span
					className={cn(
						"min-w-0 flex-1 truncate-fade",
						attention && "font-semibold",
						// Listed only while it is open, as it is not pinned.
						!bot.pinned && "italic",
					)}
				>
					{bot.name}
				</span>
				<MutedMark settings={notificationSettings} place={notificationPlace} />
			</Link>
			{endMark && <span className={END_SLOT}>{endMark}</span>}
			<span
				className={cn(
					"grid size-5.5 shrink-0 place-items-center",
					endMark &&
						"pointer-events-none absolute right-7 rounded-sm opacity-0 group-hover/bot:pointer-events-auto group-hover/bot:opacity-100 group-has-focus-visible/bot:pointer-events-auto group-has-focus-visible/bot:opacity-100 max-md:pointer-events-auto max-md:static max-md:bg-transparent max-md:opacity-100",
					endMark && "bg-row-hover",
				)}
			>
				<IconButton
					label={`New task with ${bot.name}`}
					size="sm"
					render={<Link {...newTaskLink(bot)} />}
					className={cn(
						"size-5.5",
						!endMark &&
							"opacity-0 focus-visible:opacity-100 group-hover/bot:opacity-100 max-md:opacity-100",
					)}
				>
					<Plus strokeWidth={2.2} />
				</IconButton>
			</span>
		</div>
	);
	return (
		<li className="flex flex-col">
			<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
				{row}
			</NotificationsContextMenu>
			{open && <BotTasks bot={bot} selectedConversationId={selectedConversationId} />}
		</li>
	);
}

/**
 * A bot's tasks under it: the newest few not done, and the one open on the
 * page wherever it is, done or not, then its automations.
 */
function BotTasks({ bot, selectedConversationId }: { bot: Bot; selectedConversationId?: string }) {
	const { data } = useBotTasks(bot.id);
	const tasks = data?.tasks ?? [];
	const isSelected = (conversationId: string) => conversationId === selectedConversationId;
	const shown = tasks
		.filter((row) => row.conversation.doneAt === null || isSelected(row.conversation.id))
		.filter((row, index) => index < TASKS_SHOWN || isSelected(row.conversation.id));
	const automations = data?.automations ?? [];
	return (
		<LivelyGroup>
			<ul
				className={`m-0 mt-px ml-4.25 flex list-none flex-col gap-px border-border border-l p-0 ${NESTED_INDENT}`}
			>
				{shown.map((row) => (
					<li key={row.conversation.id}>
						<TaskRow row={row} bot={bot} selected={isSelected(row.conversation.id)} />
					</li>
				))}
				{automations.length > 0 && (
					<li>
						<Link
							{...automationsLink(bot)}
							className={cn(taskRowClassName(false), "text-subtle-foreground")}
						>
							<Zap aria-hidden size={12} strokeWidth={2.25} className="shrink-0" />
							<span className="min-w-0 flex-1 truncate">Automations</span>
							<ChevronRight aria-hidden size={14} strokeWidth={2} className="shrink-0" />
						</Link>
					</li>
				)}
			</ul>
		</LivelyGroup>
	);
}

/** A row under a bot, shaded while it is the one open. */
function taskRowClassName(selected: boolean): string {
	return cn(
		"focus-ring flex h-8 min-w-0 items-center gap-2 rounded-sm pr-1.5 pl-2 text-sm transition-colors max-md:h-10 max-md:text-sm max-md:active:bg-row-selected",
		selected ? "bg-row-selected text-foreground" : "text-muted-foreground hover:text-foreground",
	);
}

/**
 * A task under its bot: its title, bold while it has unread messages, and at
 * its end a dot while it waits on the viewer. A done task is ticked and
 * greyer.
 */
function TaskRow({ row, bot, selected }: { row: ChatListItem; bot: Bot; selected: boolean }) {
	const done = row.conversation.doneAt !== null;
	const needsYou = row.needsApproval || row.mentionsYou;
	const lit = !done && (row.unreadMessages > 0 || needsYou);
	return (
		<Link
			{...conversationLink({ bot, conversationId: row.conversation.id })}
			aria-current={selected ? "page" : undefined}
			className={cn(
				taskRowClassName(selected),
				done && !selected && "text-subtle-foreground",
				lit && "font-semibold text-foreground",
			)}
		>
			{done && <Check aria-hidden size={12} strokeWidth={2.25} className="shrink-0" />}
			<span className="min-w-0 flex-1 truncate-fade">{row.conversation.title}</span>
			<span className={END_SLOT}>
				{!done && <UnreadMarker unreadMessages={row.unreadMessages} needsYou={needsYou} />}
			</span>
		</Link>
	);
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

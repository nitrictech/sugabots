import { type LivelyFace, LivelyGroup } from "@sugabots/avatars";
import {
	type Agent,
	type ChatList,
	type ChatListItem,
	FIRST_CHAT_NAME,
	type ListedRoutine,
	type NotificationSettings,
	type Pod,
} from "@sugabots/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronRight, Hash, Plus, Users } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList } from "@/lib/chats.ts";
import { agentChatLink, conversationLink, newThreadLink, podChatLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { countOf } from "@/lib/name-list.ts";
import { useNotificationSettings } from "@/lib/notifications.ts";
import { useOpenBots } from "@/lib/open-bots.ts";
import { THREADS_SHOWN } from "@/lib/screen-limits.ts";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { TurnTakingAvatar } from "@/shell/Agent.tsx";
import { FailedDot } from "@/shell/FailedDot.tsx";
import { useNewBot } from "@/shell/NewInPod.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * Which row of the list is open: the pod's first chat while it is being
 * opened, a bot's channel while it is being found by the bot's handle, a new
 * thread being started with a bot, or a conversation, which is a chat, a
 * channel, a thread or a routine's thread.
 */
export type ListSelection =
	| { kind: "podChat" }
	| { kind: "bot"; handle: string }
	| { kind: "newThread"; handle: string }
	| { kind: "conversation"; conversationId: string }
	| { kind: "routine"; routineId: string }
	/** A bot's Routines page, while none of its routines is open. */
	| { kind: "routines"; handle: string };

/** One of a shared pod's chats in its list. */
export type ListedChat = ChatList["chats"][number];

/** A bot's channel in its pod's list. */
export type ListedChannel = ChatList["channels"][number];

/**
 * The pod's conversations in the sidebar, in one list: a shared pod's
 * channels, each with the threads started from it, then each of its bots,
 * which opens its channel and unfolds to show its threads.
 */
export function ConversationList({ pod, selected }: { pod: Pod; selected?: ListSelection }) {
	const list = useChatList(pod.slug);
	const newBot = useNewBot(pod);
	const { agents } = useAgents();
	const { data: notificationSettings } = useNotificationSettings();
	return (
		// The bots' faces take turns to move, so the list never fidgets all at once.
		<LivelyGroup>
			<ConversationListView
				pod={pod}
				chats={pod.kind === "shared" ? (list.data?.chats ?? []) : undefined}
				bots={crewIn(agents, pod)}
				channels={list.data?.channels ?? []}
				rows={list.data?.threads ?? []}
				routines={list.data?.routines ?? []}
				status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
				selected={selected}
				onNewBot={newBot.start}
				notificationSettings={notificationSettings}
			/>
			{newBot.dialog}
		</LivelyGroup>
	);
}

/** The pod's own bots, leaving out the system bots every pod has. */
function crewIn(agents: readonly Agent[] | undefined, pod: Pod): Agent[] {
	return agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
}

export function ConversationListView({
	pod,
	chats,
	bots,
	channels = [],
	rows,
	routines = [],
	status,
	selected,
	onNewBot,
	notificationSettings,
}: {
	pod: Pod;
	/**
	 * A shared pod's chats, its first first, none until somebody opens one.
	 * Absent from a Personal pod, which has none.
	 */
	chats?: readonly ListedChat[];
	/** The pod's bots, each listed whether or not it has a thread yet. */
	bots: readonly Agent[];
	/** The bots' channels, none until somebody first opens one. */
	channels?: readonly ListedChannel[];
	/** The pod's threads, newest message first. */
	rows: readonly ChatListItem[];
	/** The pod's routines, which mark the bot that runs them while one failed or mentions the viewer. */
	routines?: readonly ListedRoutine[];
	status: "loading" | "ready" | "failed";
	selected?: ListSelection;
	/** Absent when the viewer may not make a bot here. */
	onNewBot?: () => void;
	/** What the viewer is notified about, once loaded, which a bot's menu changes. */
	notificationSettings?: NotificationSettings;
}) {
	const [openBots, toggleBot] = useOpenBots(pod.id);
	// A phone's Home is the list alone, with room for every bot's threads, and no channel open beside it to unfold them.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	// The open thread when the viewer closed the bot holding it, which stays closed until another opens.
	const [closedOver, setClosedOver] = useState<string>();
	const selectedId = selected?.kind === "conversation" ? selected.conversationId : undefined;
	// What is open, as `closedOver` remembers it: a conversation, or a bot whose thread is being found or started.
	const selectedKey =
		selected?.kind === "conversation"
			? selected.conversationId
			: selected?.kind === "bot" || selected?.kind === "newThread"
				? `${selected.kind}:${selected.handle}`
				: undefined;
	const selectedRoutineId = selected?.kind === "routine" ? selected.routineId : undefined;
	const routinesOf = (agentId: string | undefined) =>
		routines.filter((row) => row.agent.id === agentId);
	const isSelected = (conversationId: string | undefined) =>
		conversationId !== undefined && conversationId === selectedId;
	// The first chat is listed before anyone opens it, which opens it.
	const shownChats: (ListedChat | "unopened")[] | undefined =
		chats && (chats.some((chat) => chat.conversation.main) ? [...chats] : ["unopened", ...chats]);
	const isChatSelected = (chat: ListedChat | "unopened") =>
		chat === "unopened"
			? selected?.kind === "podChat"
			: isSelected(chat.conversation.id) ||
				(selected?.kind === "podChat" && chat.conversation.main);
	// A thread between people hangs under the chat it was started from; any other goes under its bot.
	// Done ones are kept, so a bot with only done threads still leads to them.
	const byChat = threadsByChat(chats ?? [], rows);
	const groups = groupByBot(
		bots,
		rows.filter((row) => !startedInChatOf(row, byChat)),
		channels,
	);

	return (
		<div className="flex flex-col gap-px">
			{status === "failed" && (
				<p className="m-0 px-2 pb-4 text-xs text-muted-foreground">Could not load these chats.</p>
			)}
			<ul className="m-0 flex list-none flex-col gap-px p-0">
				{shownChats?.map((chat) => {
					const under = chat === "unopened" ? undefined : byChat.get(chat.conversation.id);
					return (
						<li key={chat === "unopened" ? "unopened" : chat.conversation.id}>
							<PodChatRow pod={pod} chat={chat} selected={isChatSelected(chat)} />
							{under && <ThreadTree pod={pod} threads={under} isSelected={isSelected} />}
						</li>
					);
				})}
				{groups.map((group) => {
					const botRoutines = routinesOf(group.agent?.id);
					const routinesOpen =
						botRoutines.some((row) => row.routine.id === selectedRoutineId) ||
						(selected?.kind === "routines" && group.agent?.handle === selected.handle);
					const holdsSelected =
						(selected?.kind === "newThread" && group.agent?.handle === selected.handle) ||
						group.threads.some((row) => isSelected(row.conversation.id));
					const channelOpen =
						(selected?.kind === "bot" && group.agent?.handle === selected.handle) ||
						isSelected(group.channel?.conversation.id);
					// A bot is open while its channel or anything under it is; the threads
					// between people, which have no channel, open and close by hand.
					const open =
						phone ||
						(group.agent
							? channelOpen || holdsSelected
							: openBots.has(group.key) || (holdsSelected && closedOver !== selectedKey));
					const toggle = () => {
						if (openBots.has(group.key) === open) toggleBot(group.key);
						setClosedOver(open && holdsSelected ? selectedKey : undefined);
					};
					return (
						<BotItem
							key={group.key}
							channelOpen={channelOpen}
							routinesOpen={routinesOpen}
							pod={pod}
							group={group}
							open={open}
							onToggle={toggle}
							isSelected={isSelected}
							notificationSettings={notificationSettings}
							routinesNeedYou={botRoutines.some((row) => row.mentionsYou)}
							routineFailed={botRoutines.some((row) => row.routine.failed)}
						/>
					);
				})}
			</ul>
			{status === "ready" && groups.length === 0 && <NoBots onNewBot={onNewBot} />}
		</div>
	);
}

/** What is new across `rows`, as a folded bot says it. */
function newsIn(
	rows: readonly { unreadMessages: number; needsApproval?: boolean; mentionsYou?: boolean }[],
) {
	return {
		unreadMessages: rows.reduce((sum, row) => sum + row.unreadMessages, 0),
		needsYou: rows.some((row) => row.needsApproval || row.mentionsYou),
	};
}

/**
 * The pod's list while it has no bots: a row that adds the first, its
 * face a dashed circle, or, for somebody who may not add one, a line saying
 * there are none.
 */
function NoBots({ onNewBot }: { onNewBot?: () => void }) {
	const mark = (
		<span
			aria-hidden
			className="grid size-4.5 shrink-0 place-items-center rounded-full border border-border-strong border-dashed"
		>
			{onNewBot && <Plus size={10} strokeWidth={2.4} className="block" />}
		</span>
	);
	if (!onNewBot) {
		return (
			<p
				className={cn(
					sidebarRowClassName(false),
					"m-0 hover:bg-transparent hover:text-muted-foreground",
				)}
			>
				{mark}
				No bots yet
			</p>
		);
	}
	return (
		<button
			type="button"
			onClick={onNewBot}
			className={cn(sidebarRowClassName(false), "text-left")}
		>
			{mark}
			Add a bot
		</button>
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

/** One of the pod's chats, bright and dotted while something there is new. */
function PodChatRow({
	pod,
	chat,
	selected,
}: {
	pod: Pod;
	chat: ListedChat | "unopened";
	selected: boolean;
}) {
	const unreadMessages = chat === "unopened" ? 0 : chat.unreadMessages;
	return (
		<Link
			{...(chat === "unopened"
				? podChatLink(pod)
				: conversationLink({ pod, conversationId: chat.conversation.id }))}
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

/**
 * A bot, with its channel once somebody opened it, and its open threads,
 * newest first; or the threads between people, when `agent` is null.
 */
interface BotGroup {
	key: string;
	agent: Agent | null;
	channel?: ListedChannel;
	threads: ChatListItem[];
}

const PEOPLE_GROUP_KEY = "people";

/**
 * A group for each of the pod's bots, and for any other bot with a thread
 * here, in order of the bots' names so each stays where it was as
 * threads move, then the threads between people.
 */
function groupByBot(
	bots: readonly Agent[],
	threads: readonly ChatListItem[],
	channels: readonly ListedChannel[],
): BotGroup[] {
	const groups = new Map<string, BotGroup>();
	const groupFor = (agent: Agent | null) => {
		const key = agent?.id ?? PEOPLE_GROUP_KEY;
		const existing = groups.get(key);
		if (existing) return existing;
		const group: BotGroup = { key, agent, threads: [] };
		groups.set(key, group);
		return group;
	};
	for (const bot of bots) groupFor(bot);
	for (const row of channels) groupFor(row.agent).channel = row;
	for (const row of threads) groupFor(row.agent).threads.push(row);
	return [...groups.values()].sort((a, b) => {
		if (!a.agent) return 1;
		if (!b.agent) return -1;
		return a.agent.name.localeCompare(b.agent.name);
	});
}

/** The threads between people started from each of `chats`, newest first, by the chat's id; only chats with one. */
function threadsByChat(
	chats: readonly ListedChat[],
	rows: readonly ChatListItem[],
): Map<string, ChatListItem[]> {
	const chatIds = new Set(chats.map((chat) => chat.conversation.id));
	const byChat = new Map<string, ChatListItem[]>();
	for (const row of rows) {
		const chat = row.agent === null ? row.conversation.startedInChatId : null;
		if (chat === null || !chatIds.has(chat)) continue;
		byChat.set(chat, [...(byChat.get(chat) ?? []), row]);
	}
	return byChat;
}

/** Whether `row` hangs under a chat in `byChat`, rather than under its bot. */
function startedInChatOf(
	row: ChatListItem,
	byChat: ReadonlyMap<string, readonly ChatListItem[]>,
): boolean {
	return (
		row.agent === null &&
		row.conversation.startedInChatId !== null &&
		byChat.has(row.conversation.startedInChatId)
	);
}

/** A row's height and type on a phone, where a thumb taps it rather than a pointer, shaded while pressed. */
const PHONE_ROW =
	"max-md:h-11 max-md:gap-3 max-md:rounded-lg max-md:text-base max-md:active:bg-row-selected";

/** A bot's own part of its row: its face and name, filling the row up to its end. */
const botClassName =
	"focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm pl-2 text-left text-sm max-md:gap-3 max-md:rounded-lg max-md:text-base";

/**
 * A bot on one line, which opens its channel, with its threads under it
 * while it or one of them is open. At its end, what is new in its channel
 * and, folded, under it, or a red dot while one of its routines failed; under
 * the pointer, a + that starts a new thread with it. The threads between people,
 * which have no channel, unfold from the whole row, where a caret takes the
 * place of their mark under the pointer or on focus. Right-clicked, a bot
 * offers its notifications.
 */

function BotItem({
	pod,
	group,
	open,
	channelOpen,
	routinesOpen,
	onToggle,
	isSelected,
	routinesNeedYou,
	routineFailed,
	notificationSettings,
}: {
	pod: Pod;
	group: BotGroup;
	open: boolean;
	/** Whether the bot's channel is the page open, or being opened. */
	channelOpen: boolean;
	/** Folds the threads between people away or opens them; a bot opens with its channel instead. */
	onToggle: () => void;
	isSelected: (conversationId: string | undefined) => boolean;
	/** Whether the bot's Routines page, or one of its routines, is the page open. */
	routinesOpen: boolean;
	/** Whether one of its routines' threads mentions the viewer. */
	routinesNeedYou: boolean;
	/** Whether one of its routines failed its latest run. */
	routineFailed: boolean;
	notificationSettings?: NotificationSettings;
}) {
	const { agent, channel } = group;
	// Its face hops when the pointer moves onto the row.
	const face = useRef<LivelyFace>(null);
	// Unfolded, what is new in the threads shows on their own rows.
	const folded = newsIn(
		open ? [] : group.threads.filter((row) => row.conversation.doneAt === null),
	);
	const unread = (channel?.unreadMessages ?? 0) + folded.unreadMessages;
	const waiting =
		channel?.needsApproval || channel?.mentionsYou || folded.needsYou || routinesNeedYou;
	const attention = unread > 0 || waiting === true;
	// Shaded while its channel or its routines are open, the bot being where its routines are reached.
	const shaded = channelOpen || routinesOpen;
	// A failed routine shows as its own dot, unless a dot already says the bot needs you.
	const endMark =
		attention || routineFailed ? (
			<>
				<UnreadMarker unreadMessages={unread} needsYou={waiting === true} />
				{routineFailed &&
					(waiting ? <span className="sr-only">, latest routine run failed</span> : <FailedDot />)}
			</>
		) : undefined;
	const mark = agent ? (
		<TurnTakingAvatar bot={agent} size={18} faceRef={face} className="shrink-0" />
	) : (
		<Users aria-hidden size={16} strokeWidth={1.75} className="mx-px shrink-0" />
	);
	// Under the pointer or on focus, a caret takes the mark's place, as on a pod.
	const markWithCaret = (
		<span className="grid size-4.5 shrink-0 place-items-center *:col-start-1 *:row-start-1">
			<span className="grid group-hover/bot:invisible group-has-focus-visible/bot:invisible">
				{mark}
			</span>
			<ChevronRight
				aria-hidden
				size={14}
				strokeWidth={2.25}
				className={cn(
					"invisible text-muted-foreground transition-transform group-hover/bot:visible group-has-focus-visible/bot:visible",
					open && "rotate-90",
				)}
			/>
		</span>
	);
	const nameClassName =
		attention || shaded
			? "text-foreground"
			: "text-muted-foreground group-hover/bot:text-foreground";
	// Only a pod's own bots have notifications of their own; the rest follow the pod.
	const notificationPlace = agent?.podId
		? ({ kind: "bot", id: agent.id, podId: agent.podId } as const)
		: undefined;
	const label = (
		<>
			<span className={cn("min-w-0 flex-1 truncate-fade", attention && "font-semibold")}>
				{agent ? agent.name : "People"}
			</span>
			{notificationPlace && <MutedMark settings={notificationSettings} place={notificationPlace} />}
		</>
	);
	const row = (
		<div
			onPointerEnter={() => face.current?.play("hop")}
			className={cn(
				"group/bot relative flex h-8 items-center rounded-sm pr-1.5 max-md:h-11 max-md:rounded-lg max-md:active:bg-row-selected",
				shaded ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			{agent ? (
				<Link
					{...(channel
						? conversationLink({ pod, conversationId: channel.conversation.id })
						: agentChatLink({ pod, agent }))}
					// Its routines open beside it are part of the bot, though not the link's own page.
					aria-current={channelOpen ? "page" : routinesOpen ? "true" : undefined}
					className={cn(botClassName, nameClassName)}
				>
					{mark}
					{label}
				</Link>
			) : (
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className={cn(botClassName, nameClassName)}
				>
					{markWithCaret}
					{label}
				</button>
			)}
			{/* What is unread stays in its place, in line with every row's; the + shows under the pointer or on focus, over the end of the name beside it, and always on a phone. */}
			{endMark && <span className={END_SLOT}>{endMark}</span>}
			<span
				className={cn(
					"grid size-5.5 shrink-0 place-items-center",
					endMark &&
						"pointer-events-none absolute right-7 rounded-sm opacity-0 group-hover/bot:pointer-events-auto group-hover/bot:opacity-100 group-has-focus-visible/bot:pointer-events-auto group-has-focus-visible/bot:opacity-100 max-md:pointer-events-auto max-md:static max-md:bg-transparent max-md:opacity-100",
					endMark && (shaded ? "bg-row-selected" : "bg-row-hover"),
				)}
			>
				<IconButton
					label={agent ? `New thread with ${agent.name}` : "New thread with people"}
					size="sm"
					render={<Link {...newThreadLink(pod, agent ?? undefined)} />}
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
			{notificationPlace ? (
				<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
					{row}
				</NotificationsContextMenu>
			) : (
				row
			)}
			{open && group.threads.length > 0 && (
				<ThreadTree
					pod={pod}
					threads={group.threads}
					isSelected={isSelected}
					last={
						agent && (
							<AllThreadsRow pod={pod} agent={agent} channel={channel} channelOpen={channelOpen} />
						)
					}
				/>
			)}
		</li>
	);
}

/**
 * Threads hanging under a bot or a chat that aren't done, and the one open on
 * the page wherever it is, done or not, then `last`. With `last`, the way to
 * all of a bot's threads, only the newest few show, and it leads to the rest.
 * Nothing while none is shown and there is no `last`.
 */
function ThreadTree({
	pod,
	threads,
	isSelected,
	last,
}: {
	pod: Pod;
	/** Newest first, done ones included. */
	threads: readonly ChatListItem[];
	isSelected: (conversationId: string | undefined) => boolean;
	/** A last row after the threads. */
	last?: ReactNode;
}) {
	// Done threads leave the sidebar, but for the one open, so marking it done doesn't pull it from under you.
	const listed = threads.filter(
		(row) => row.conversation.doneAt === null || isSelected(row.conversation.id),
	);
	const shownThreads = last ? THREADS_SHOWN : Infinity;
	const shown = listed.filter(
		(row, index) => index < shownThreads || isSelected(row.conversation.id),
	);
	if (shown.length === 0 && !last) return null;
	return (
		<ul
			className={`m-0 mt-px ml-4.25 flex list-none flex-col gap-px border-border border-l p-0 ${NESTED_INDENT}`}
		>
			{shown.map((row) => (
				<li key={row.conversation.id}>
					<ThreadRow row={row} pod={pod} selected={isSelected(row.conversation.id)} />
				</li>
			))}
			{last && <li>{last}</li>}
		</ul>
	);
}

/**
 * The way to all of a bot's threads, done ones included, which opens them
 * beside its channel; shaded while they are open there.
 */
function AllThreadsRow({
	pod,
	agent,
	channel,
	channelOpen,
}: {
	pod: Pod;
	agent: Agent;
	channel?: ListedChannel;
	/** Whether the bot's channel is the page open, beside which its threads open. */
	channelOpen: boolean;
}) {
	const threadsOpen = useSearch({
		strict: false,
		select: (search) => search.threads !== undefined,
	});
	const selected = channelOpen && threadsOpen;
	const search = { threads: "open" } as const;
	return (
		<Link
			{...(channel
				? conversationLink({ pod, conversationId: channel.conversation.id }, search)
				: agentChatLink({ pod, agent }, search))}
			aria-current={selected ? "true" : undefined}
			className={cn(threadRowClassName(selected), !selected && "text-subtle-foreground")}
		>
			<span className="min-w-0 flex-1 truncate">All threads</span>
			<ChevronRight aria-hidden size={14} strokeWidth={2} className="shrink-0" />
		</Link>
	);
}

/** A row under a bot or a channel, shaded while it is the one open. */
function threadRowClassName(selected: boolean): string {
	return cn(
		"focus-ring flex h-8 min-w-0 items-center gap-2 rounded-sm pr-1.5 pl-2 text-sm transition-colors max-md:h-10 max-md:text-sm max-md:active:bg-row-selected",
		selected ? "bg-row-selected text-foreground" : "text-muted-foreground hover:text-foreground",
	);
}

/**
 * A thread under its bot: its title, bold while it has unread messages, and
 * at its end a dot while it waits on the viewer. A done thread is ticked and
 * greyer.
 */
function ThreadRow({ row, pod, selected }: { row: ChatListItem; pod: Pod; selected: boolean }) {
	// Listed while it is the one open, as it is just after it is marked done.
	const done = row.conversation.doneAt !== null;
	// In a Personal pod a conversation is with the bot, so goes by its name.
	const title = pod.kind === "personal" && row.agent ? row.agent.name : row.conversation.title;
	const needsYou = row.needsApproval || row.mentionsYou;
	const lit = !done && (row.unreadMessages > 0 || needsYou);
	return (
		<Link
			{...conversationLink({ pod, conversationId: row.conversation.id })}
			aria-current={selected ? "page" : undefined}
			className={cn(
				threadRowClassName(selected),
				done && !selected && "text-subtle-foreground",
				lit && "font-semibold text-foreground",
			)}
		>
			{done && <Check aria-hidden size={12} strokeWidth={2.25} className="shrink-0" />}
			<span className="min-w-0 flex-1 truncate-fade">{title}</span>
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
function UnreadMarker({ unreadMessages, needsYou }: { unreadMessages: number; needsYou: boolean }) {
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

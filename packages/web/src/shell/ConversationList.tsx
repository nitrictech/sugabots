import {
	type Agent,
	type ChatList,
	type ChatListItem,
	FIRST_CHAT_NAME,
	type ListedRoutine,
	type Pod,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronRight, Hash, Plus, RefreshCcw, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList, useStartChat } from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import {
	agentChatLink,
	conversationLink,
	newThreadLink,
	podChatLink,
	routinesLink,
} from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { useOpenBots } from "@/lib/open-bots.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * Which row of the list is open: the pod's first chat while it is being
 * opened, a bot's conversation while it is being found by the bot's handle,
 * or a conversation, which is a chat, a thread or a routine's thread.
 */
export type ListSelection =
	| { kind: "podChat" }
	| { kind: "bot"; handle: string }
	| { kind: "conversation"; conversationId: string }
	| { kind: "routine"; routineId: string }
	/** A bot's Routines page, while none of its routines is open. */
	| { kind: "routines"; handle: string };

/** One of a shared pod's chats in its list. */
export type ListedChat = ChatList["chats"][number];

/**
 * The pod's conversations in the sidebar: a shared pod's chats, then each of
 * its bots, which opens to show its threads.
 */
export function ConversationList({ pod, selected }: { pod: Pod; selected?: ListSelection }) {
	const list = useChatList(pod.slug);
	const [creating, setCreating] = useState(false);
	const [namingChat, setNamingChat] = useState(false);
	const startChat = useStartChat(pod);
	const navigate = useNavigate();
	const newBot = pod.permissions.createAgents ? () => setCreating(true) : undefined;
	const { agents } = useAgents();
	return (
		<>
			<ConversationListView
				pod={pod}
				chats={
					pod.kind === "shared"
						? { list: list.data?.chats ?? [], onNew: () => setNamingChat(true) }
						: undefined
				}
				bots={crewIn(agents, pod)}
				rows={list.data?.threads ?? []}
				routines={list.data?.routines ?? []}
				status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
				selected={selected}
				onNewBot={newBot}
			/>
			<Dialog open={namingChat} onOpenChange={setNamingChat}>
				<ChatNameDialog
					title="New channel"
					action="Create"
					onSave={async (name) => {
						const started = await startChat.mutateAsync(name);
						setNamingChat(false);
						await navigate(conversationLink({ pod, conversationId: started.id }));
					}}
				/>
			</Dialog>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewAgentDialog
					podId={pod.id}
					pods={[pod]}
					onCreated={async (agent) => {
						setCreating(false);
						await navigate(agentChatLink({ pod, agent }));
					}}
				/>
			</Dialog>
		</>
	);
}

/** The pod's own bots, leaving out the system bots every pod has. */
export function crewIn(agents: readonly Agent[] | undefined, pod: Pod): Agent[] {
	return agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
}

export function ConversationListView({
	pod,
	chats,
	bots,
	rows,
	routines = [],
	status,
	selected,
	onNewBot,
}: {
	pod: Pod;
	/**
	 * A shared pod's chats, its first first, none until somebody opens one, and
	 * what starts another. Absent from a Personal pod, which has none.
	 */
	chats?: { list: readonly ListedChat[]; onNew: () => void };
	/** The pod's bots, each listed whether or not it has a thread yet. */
	bots: readonly Agent[];
	/** The pod's threads, newest message first. */
	rows: readonly ChatListItem[];
	/** The pod's routines, each listed under the bot that runs it. */
	routines?: readonly ListedRoutine[];
	status: "loading" | "ready" | "failed";
	selected?: ListSelection;
	/** Absent when the viewer may not make a bot here. */
	onNewBot?: () => void;
}) {
	const [openBots, toggleBot] = useOpenBots(pod.id);
	const [folded, toggleFolded] = useFolded();
	const chatsKey = `chats:${pod.id}`;
	const botsKey = `bots:${pod.id}`;
	// The open thread when the viewer closed the bot holding it, which stays closed until another opens.
	const [closedOver, setClosedOver] = useState<string>();
	const selectedId = selected?.kind === "conversation" ? selected.conversationId : undefined;
	// What is open, as `closedOver` remembers it: a conversation, or a bot whose thread is being found or started.
	const selectedKey =
		selected?.kind === "conversation"
			? selected.conversationId
			: selected?.kind === "bot"
				? `bot:${selected.handle}`
				: selected?.kind === "routine"
					? `routine:${selected.routineId}`
					: selected?.kind === "routines"
						? `routines:${selected.handle}`
						: undefined;
	const selectedRoutineId = selected?.kind === "routine" ? selected.routineId : undefined;
	const routinesOf = (agentId: string | undefined) =>
		routines.filter((row) => row.agent.id === agentId);
	const isSelected = (conversationId: string | undefined) =>
		conversationId !== undefined && conversationId === selectedId;
	// The first chat is listed before anyone opens it, which opens it.
	const shownChats: (ListedChat | "unopened")[] | undefined =
		chats &&
		(chats.list.some((chat) => chat.conversation.main)
			? [...chats.list]
			: ["unopened", ...chats.list]);
	const isChatSelected = (chat: ListedChat | "unopened") =>
		chat === "unopened"
			? selected?.kind === "podChat"
			: isSelected(chat.conversation.id) ||
				(selected?.kind === "podChat" && chat.conversation.main);
	// Done threads leave the sidebar, but for the one open, so marking it done doesn't pull it from under you.
	const listed = rows.filter(
		(row) => row.conversation.doneAt === null || isSelected(row.conversation.id),
	);
	// A thread between people hangs under the chat it was started from; any other goes under its bot.
	const byChat = threadsByChat(chats?.list ?? [], listed);
	const groups = groupByBot(
		bots,
		listed.filter((row) => !startedInChatOf(row, byChat)),
	);

	return (
		<div className="flex flex-col gap-px">
			{status === "failed" && (
				<p className="m-0 px-2 pb-4 text-[13px] text-muted-foreground">
					Could not load these chats.
				</p>
			)}
			{chats && shownChats && (
				<div className="flex flex-col gap-px">
					<SectionHeading
						label="Channels"
						open={!folded.has(chatsKey)}
						onToggle={() => toggleFolded(chatsKey)}
						news={newsIn([...chats.list, ...[...byChat.values()].flat()])}
						action={
							<IconButton label={`New channel in ${pod.name}`} size="sm" onClick={chats.onNew}>
								<Plus strokeWidth={2.2} />
							</IconButton>
						}
					/>
					{!folded.has(chatsKey) && (
						<ul className={cn("m-0 flex list-none flex-col gap-px p-0", NESTED_INDENT)}>
							{shownChats.map((chat) => {
								const under = chat === "unopened" ? undefined : byChat.get(chat.conversation.id);
								return (
									<li key={chat === "unopened" ? "unopened" : chat.conversation.id}>
										<PodChatRow pod={pod} chat={chat} selected={isChatSelected(chat)} />
										{under && <ThreadTree pod={pod} threads={under} isSelected={isSelected} />}
									</li>
								);
							})}
						</ul>
					)}
				</div>
			)}
			<div className="flex flex-col gap-px">
				<SectionHeading
					label="Bots"
					open={!folded.has(botsKey)}
					onToggle={() => toggleFolded(botsKey)}
					news={newsIn(groups.flatMap((group) => group.threads))}
					action={
						onNewBot && (
							<IconButton label={`New bot in ${pod.name}`} size="sm" onClick={onNewBot}>
								<Plus strokeWidth={2.2} />
							</IconButton>
						)
					}
				/>
				{folded.has(botsKey) ? null : (
					<div className={cn("flex flex-col gap-px", NESTED_INDENT)}>
						{status === "ready" && groups.length === 0 && <NoBots onNewBot={onNewBot} />}
						<ul className="m-0 flex list-none flex-col gap-px p-0">
							{groups.map((group) => {
								// A thread opened under a closed bot opens it, so the viewer can see where they are.
								const botRoutines = routinesOf(group.agent?.id);
								const holdsRoutine =
									botRoutines.some((row) => row.routine.id === selectedRoutineId) ||
									(selected?.kind === "routines" && group.agent?.handle === selected.handle);
								const holdsSelected =
									(selected?.kind === "bot" && group.agent?.handle === selected.handle) ||
									group.threads.some((row) => isSelected(row.conversation.id)) ||
									holdsRoutine;
								const open =
									openBots.has(group.key) || (holdsSelected && closedOver !== selectedKey);
								const toggle = () => {
									if (openBots.has(group.key) === open) toggleBot(group.key);
									setClosedOver(open && holdsSelected ? selectedKey : undefined);
								};
								return (
									<BotItem
										key={group.key}
										starting={selected?.kind === "bot" && group.agent?.handle === selected.handle}
										pod={pod}
										group={group}
										open={open}
										onToggle={toggle}
										isSelected={isSelected}
										routines={
											group.agent && (
												<BotRoutines
													pod={pod}
													agent={group.agent}
													routines={botRoutines}
													selected={holdsRoutine}
												/>
											)
										}
										routinesNeedYou={botRoutines.some((row) => row.mentionsYou)}
									/>
								);
							})}
						</ul>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * A section's name in small grey type, which folds the section away or opens
 * it, with its one action at the end. Folded, it says what is new in it.
 */
function SectionHeading({
	label,
	open,
	onToggle,
	news,
	action,
}: {
	label: string;
	open: boolean;
	onToggle: () => void;
	news: { unreadMessages: number; needsYou: boolean };
	action?: ReactNode;
}) {
	return (
		<h2 className="group/section m-0 flex h-8 items-center rounded-[6px] pr-1.5 font-normal text-[14px] text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className={cn(
					"focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[6px] pl-2 text-left",
					// Folded over something new, it is bright, as a bot is.
					!open && hasNews(news) && "font-semibold text-foreground",
				)}
			>
				<span className="grid size-[18px] shrink-0 place-items-center">
					<ChevronRight
						aria-hidden
						size={14}
						strokeWidth={2.25}
						className={cn("transition-transform", open && "rotate-90")}
					/>
				</span>
				{label}
			</button>
			{!open && (
				<span className={END_SLOT}>
					<UnreadMarker {...news} />
				</span>
			)}
			{/* The action comes in under the pointer or on focus, beside what is new. */}
			<span
				className={cn(
					END_SLOT,
					!open && hasNews(news)
						? "hidden group-hover/section:grid group-has-focus-visible/section:grid"
						: "opacity-0 group-hover/section:opacity-100 group-has-focus-visible/section:opacity-100",
				)}
			>
				{action}
			</span>
		</h2>
	);
}

function hasNews(news: { unreadMessages: number; needsYou: boolean }): boolean {
	return news.unreadMessages > 0 || news.needsYou;
}

/** What is new across `rows`, as a folded section says it. */
function newsIn(
	rows: readonly { unreadMessages: number; needsApproval?: boolean; mentionsYou?: boolean }[],
) {
	return {
		unreadMessages: rows.reduce((sum, row) => sum + row.unreadMessages, 0),
		needsYou: rows.some((row) => row.needsApproval || row.mentionsYou),
	};
}

/**
 * The Bots section while the pod has none: a row that adds the first, its
 * face a dashed circle, or, for somebody who may not add one, a line saying
 * there are none.
 */
function NoBots({ onNewBot }: { onNewBot?: () => void }) {
	const mark = (
		<span
			aria-hidden
			className="grid size-[18px] shrink-0 place-items-center rounded-full border border-border-strong border-dashed"
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

/** A row of the sidebar: a link or button 36px tall, shaded while it is the one open. */
function sidebarRowClassName(selected: boolean): string {
	return cn(
		"focus-ring flex h-8 min-w-0 items-center gap-2.5 rounded-[6px] pr-1.5 pl-2 text-[14px] transition-colors",
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

/** A bot's open threads, newest first; or the threads between people, when `agent` is null. */
interface BotGroup {
	key: string;
	agent: Agent | null;
	threads: ChatListItem[];
}

const PEOPLE_GROUP_KEY = "people";

/**
 * A group for each of the pod's bots, and for any other bot with a thread
 * here, in order of the bots' names so each stays where it was as
 * threads move, then the threads between people.
 */
function groupByBot(bots: readonly Agent[], threads: readonly ChatListItem[]): BotGroup[] {
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

/** Whether something under a bot is new to the viewer or waits on them. */
function needsAttention(group: BotGroup): boolean {
	return group.threads.some(
		(row) => row.needsApproval || row.mentionsYou || row.unreadMessages > 0,
	);
}

/** A bot's own part of its row: its face and name, filling the row up to its end. */
const botClassName =
	"focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[6px] pl-2 text-left text-[14px]";

/** How many of a bot's open threads show before Show more. */
const THREADS_BEFORE_SHOW_MORE = 4;

/**
 * A bot on one line, which opens to show its threads, or, with none, opens a
 * new thread with it. At its end, folded,
 * how many of their messages are unread, or how many threads it has when none
 * are; under the pointer or while it is open, a + that starts a new thread
 * with it.
 */
function BotItem({
	pod,
	group,
	open,
	starting,
	onToggle,
	isSelected,
	routines,
	routinesNeedYou = false,
}: {
	pod: Pod;
	group: BotGroup;
	open: boolean;
	/** Whether a new thread with the bot is being started, which marks it when it has no other. */
	starting: boolean;
	onToggle: () => void;
	isSelected: (conversationId: string | undefined) => boolean;
	/** The bot's Routines row, under its threads, when it runs any. */
	routines?: ReactNode;
	/** Whether one of its routines' threads mentions the viewer. */
	routinesNeedYou?: boolean;
}) {
	const { agent } = group;
	const attention = !open && (needsAttention(group) || routinesNeedYou);
	const count = group.threads.length;
	// Folded, a bot is bold over unread threads, and tells a screen reader how many messages.
	const unread = group.threads.reduce((sum, row) => sum + row.unreadMessages, 0);
	const waiting =
		routinesNeedYou || group.threads.some((row) => row.needsApproval || row.mentionsYou);
	const name = agent ? agent.name : "People";
	const empty = count === 0 && !routines;
	// The bot is the open row while a new thread with it is started.
	const current = starting;
	const mark = agent ? (
		<AgentAvatar
			color={agent.color}
			face={agent.face}
			shape={agent.shape}
			size={18}
			className="shrink-0"
		/>
	) : (
		<Users aria-hidden size={16} strokeWidth={1.75} className="mx-px shrink-0" />
	);
	const label = <span className="min-w-0 flex-1 truncate-fade">{name}</span>;
	return (
		<li className="flex flex-col">
			<div
				className={cn(
					"group/bot flex h-8 items-center rounded-[6px] pr-1.5",
					current ? "bg-row-selected" : "hover:bg-row-hover",
				)}
			>
				{empty ? (
					// With no thread to show, the bot opens a new one with it.
					<Link
						{...newThreadLink(pod, agent ?? undefined)}
						aria-current={current ? "page" : undefined}
						className={cn(
							botClassName,
							current ? "text-foreground" : "text-muted-foreground group-hover/bot:text-foreground",
						)}
					>
						{mark}
						{label}
					</Link>
				) : (
					<button
						type="button"
						aria-expanded={open}
						aria-current={current ? "page" : undefined}
						onClick={onToggle}
						className={cn(
							botClassName,
							attention || current
								? "text-foreground"
								: "text-muted-foreground group-hover/bot:text-foreground",
							attention && "font-semibold",
						)}
					>
						{/* Under the pointer or on focus, a caret takes the mark's place, as on a pod. */}
						<span className="grid size-[18px] shrink-0 place-items-center *:col-start-1 *:row-start-1">
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
						{label}
					</button>
				)}
				{/* What is unread stays in view; the + comes in beside it under the pointer or on focus. */}
				{attention && (
					<span className={END_SLOT}>
						<UnreadMarker unreadMessages={unread} needsYou={waiting} />
					</span>
				)}
				{/* Otherwise the count and the + share the end: the count while folded, the + under the pointer or on focus. */}
				<span
					className={cn(
						"size-[22px] shrink-0 place-items-center *:col-start-1 *:row-start-1",
						attention ? "hidden group-has-focus-visible/bot:grid group-hover/bot:grid" : "grid",
					)}
				>
					{!attention && count > 0 && (
						<span
							aria-hidden
							className={cn(
								"text-[12px] text-subtle-foreground tabular-nums group-has-focus-visible/bot:invisible group-hover/bot:invisible",
								open && "invisible",
							)}
						>
							{count}
						</span>
					)}
					<IconButton
						label={agent ? `New thread with ${agent.name}` : "New thread with people"}
						size="sm"
						render={<Link {...newThreadLink(pod, agent ?? undefined)} />}
						className={cn(
							"size-[22px]",
							!attention && "opacity-0 focus-visible:opacity-100 group-hover/bot:opacity-100",
						)}
					>
						<Plus strokeWidth={2.2} />
					</IconButton>
				</span>
			</div>
			{open && !empty && (
				<ThreadTree pod={pod} threads={group.threads} isSelected={isSelected} before={routines} />
			)}
		</li>
	);
}

/**
 * Threads hanging under a bot or a chat: the first few, and the one open on
 * the page wherever it is, then how many more.
 */
function ThreadTree({
	pod,
	threads,
	isSelected,
	before,
}: {
	pod: Pod;
	/** Newest first. */
	threads: readonly ChatListItem[];
	isSelected: (conversationId: string | undefined) => boolean;
	/** A first row before the threads, such as the bot's Routines. */
	before?: ReactNode;
}) {
	// Showing all its rows, after Show more, until the page is left.
	const [unclipped, setUnclipped] = useState(false);
	const shownThreads = unclipped ? Infinity : THREADS_BEFORE_SHOW_MORE;
	const shown = threads.filter(
		(row, index) => index < shownThreads || isSelected(row.conversation.id),
	);
	const hidden = threads.length - shown.length;
	return (
		<ul
			className={`m-0 mt-px ml-[17px] flex list-none flex-col gap-px border-border border-l p-0 ${NESTED_INDENT}`}
		>
			{before && <li>{before}</li>}
			{shown.map((row) => (
				<li key={row.conversation.id}>
					<ThreadRow row={row} pod={pod} selected={isSelected(row.conversation.id)} />
				</li>
			))}
			{hidden > 0 && (
				<li>
					<button type="button" onClick={() => setUnclipped(true)} className={quietButtonClassName}>
						Show {hidden} more
					</button>
				</li>
			)}
		</ul>
	);
}

/**
 * A bot's routines, as its first row, whether it runs any yet or not, which
 * opens its Routines page. A red dot while one of them failed its latest run;
 * shaded while its page is open.
 */
function BotRoutines({
	pod,
	agent,
	routines,
	selected,
}: {
	pod: Pod;
	agent: Agent;
	routines: readonly ListedRoutine[];
	selected: boolean;
}) {
	return (
		<Link
			{...routinesLink(pod, agent)}
			aria-current={selected ? "page" : undefined}
			className={cn(
				threadRowClassName(selected),
				routines.some((row) => row.mentionsYou) && "font-semibold text-foreground",
			)}
		>
			<RefreshCcw aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
			<span className="min-w-0 flex-1 truncate">Routines</span>
			{routines.some((row) => row.routine.failed) && <FailedDot />}
		</Link>
	);
}

/** A red dot at a row's end while a routine's latest run failed. */
function FailedDot() {
	return (
		<span className="mr-1 size-1.5 shrink-0 rounded-full bg-destructive-text">
			<span className="sr-only">Latest run failed</span>
		</span>
	);
}

/** A small grey text button under a bot's threads, such as Show more. */
const quietButtonClassName =
	"focus-ring flex h-7 w-full items-center rounded-[6px] px-2 text-left text-[12px] text-subtle-foreground hover:text-muted-foreground";

/** A row under a bot, shaded while it is the one open. */
function threadRowClassName(selected: boolean): string {
	return cn(
		"focus-ring flex h-8 min-w-0 items-center gap-2 rounded-[6px] pr-1.5 pl-2 text-[14px] transition-colors",
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
const END_SLOT = "grid w-[22px] shrink-0 place-items-center";

/**
 * At a row's end: a dot while it waits on the viewer, as a decision or a
 * mention does. Unread messages show in the row's bold name, so they are only
 * counted for a screen reader.
 */
function UnreadMarker({ unreadMessages, needsYou }: { unreadMessages: number; needsYou: boolean }) {
	const unread = unreadMessages > 0 && countOf(unreadMessages, "unread message", "unread messages");
	if (!needsYou) return unread ? <span className="sr-only">{unread}</span> : null;
	return (
		<span className="size-1.5 rounded-full bg-foreground">
			<span className="sr-only">{unread ? `${unread}, needs you` : "Needs you"}</span>
		</span>
	);
}

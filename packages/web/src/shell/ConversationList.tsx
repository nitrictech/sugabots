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
import {
	ChevronRight,
	Library,
	ListFilter,
	MessageSquare,
	Plus,
	RefreshCw,
	Settings2,
	Users,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList, useStartChat } from "@/lib/chats.ts";
import {
	agentChatLink,
	artifactsLink,
	conversationLink,
	newThreadLink,
	podChatLink,
	podSettingsLink,
	routineThreadLink,
} from "@/lib/links.ts";
import { type ListGrouping, useFoldedBots, useListGrouping } from "@/lib/list-grouping.ts";
import { countOf } from "@/lib/name-list.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ChatNameDialog } from "@/shell/ChatNameDialog.tsx";
import { ListColumn } from "@/shell/ListColumn.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { PodChatTile } from "@/shell/PodChatTile.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * Which row of the list is open: the pod's first chat while it is being
 * opened, or a conversation, which is a chat, a thread or a routine's thread.
 */
export type ListSelection = { kind: "podChat" } | { kind: "conversation"; conversationId: string };

/** One of a shared pod's chats in its list. */
export type ListedChat = ChatList["chats"][number];

/**
 * The column of conversations for the pod chosen on the rail: a shared pod's
 * chat first, then its threads, newest message first or under their bots.
 */
export function ConversationList({
	pod,
	selected,
	className,
}: {
	pod: Pod;
	selected?: ListSelection;
	className?: string;
}) {
	const list = useChatList(pod.slug);
	const [creating, setCreating] = useState(false);
	const [namingChat, setNamingChat] = useState(false);
	const startChat = useStartChat(pod);
	const [grouping, setGrouping] = useListGrouping(pod.id);
	const navigate = useNavigate();
	const newBot = pod.permissions.createAgents ? () => setCreating(true) : undefined;
	const { agents } = useAgents();
	const hasBots = agents?.some((agent) => agent.podId === pod.id) ?? true;
	const emptyState: EmptyList = {
		title: `No bots in ${pod.name} yet`,
		hint: newBot ? undefined : "Someone who runs this pod can add one.",
		action: newBot ? { label: "New bot", onClick: newBot } : undefined,
	};
	return (
		<>
			<ConversationListView
				pod={pod}
				chats={
					pod.kind === "shared"
						? { list: list.data?.chats ?? [], onNew: () => setNamingChat(true) }
						: undefined
				}
				rows={list.data?.threads ?? []}
				routines={list.data?.routines ?? []}
				hasBots={hasBots}
				grouping={grouping}
				onGroupingChange={setGrouping}
				status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
				selected={selected}
				onNewBot={newBot}
				emptyState={emptyState}
				className={className}
			/>
			<Dialog open={namingChat} onOpenChange={setNamingChat}>
				<ChatNameDialog
					title="New chat"
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

/** What an empty list says, and the one thing that would fill it. */
export interface EmptyList {
	title: string;
	/** For when there is nothing the viewer can do themselves, or it needs a word of why. */
	hint?: string;
	action?: { label: string; onClick: () => void };
}

export function ConversationListView({
	pod,
	chats,
	rows,
	routines,
	hasBots,
	grouping,
	onGroupingChange,
	status,
	selected,
	onNewBot,
	emptyState,
	className,
}: {
	pod: Pod;
	/**
	 * A shared pod's chats, its first first, none until somebody opens one, and
	 * what starts another. Absent from a Personal pod, which has none.
	 */
	chats?: { list: readonly ListedChat[]; onNew: () => void };
	/** The pod's threads, newest message first. */
	rows: readonly ChatListItem[];
	/** The pod's routines, under their own heading, folded until opened. */
	routines: readonly ListedRoutine[];
	/** Whether the pod has bots; one without says so, with the way to make the first. */
	hasBots: boolean;
	/**
	 * Newest first, or a section for each bot holding its open threads and
	 * routines. A Personal pod's list is already one row for each bot, so has no choice.
	 */
	grouping: ListGrouping;
	onGroupingChange: (grouping: ListGrouping) => void;
	status: "loading" | "ready" | "failed";
	selected?: ListSelection;
	/** Absent when the viewer may not make a bot here. */
	onNewBot?: () => void;
	emptyState: EmptyList;
	className?: string;
}) {
	const backToChat = useBackToHere("Chat");
	// A Personal pod's conversations are its person's own with their bots, never done.
	const direct = pod.kind === "personal";
	const open = direct ? rows : rows.filter((row) => row.conversation.doneAt === null);
	const done = direct ? [] : rows.filter((row) => row.conversation.doneAt !== null);
	const [doneShown, setDoneShown] = useState(false);
	const byBot = !direct && grouping === "bot";
	const [foldedBots, toggleBot] = useFoldedBots(pod.id);
	// Folded until opened, unless a routine has failed, which opens it.
	const [routinesChosen, setRoutinesShown] = useState<boolean>();
	const routinesShown = routinesChosen ?? routines.some((row) => row.routine.failed);
	const isSelected = (conversationId: string | undefined) =>
		selected?.kind === "conversation" && conversationId === selected.conversationId;
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
	const empty = status === "ready" && rows.length === 0 && !hasBots;
	const noBots = (
		// A little above the middle, as the design sets it, with the one next step under it.
		<div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-6 pb-[18%] text-center">
			<div className="flex flex-col gap-1.5">
				<p className="m-0 font-medium text-[14.5px] text-muted-foreground">{emptyState.title}</p>
				{emptyState.hint && (
					<p className="m-0 max-w-[240px] text-[13px] text-subtle-foreground leading-normal">
						{emptyState.hint}
					</p>
				)}
			</div>
			{emptyState.action && (
				<button
					type="button"
					onClick={emptyState.action.onClick}
					className="focus-ring flex h-10 items-center gap-[7px] rounded-[20px] bg-switch-on px-[18px] font-semibold text-[14px] text-white transition-colors hover:bg-primary"
				>
					<Plus size={15} strokeWidth={2.6} />
					{emptyState.action.label}
				</button>
			)}
		</div>
	);

	return (
		<ListColumn
			title={pod.name}
			className={className}
			actions={
				<>
					{!direct && !empty && (
						<GroupingMenu grouping={grouping} onGroupingChange={onGroupingChange} />
					)}
					{onNewBot && !empty && (
						<IconButton label={`New bot in ${pod.name}`} variant="bar" onClick={onNewBot}>
							<Plus size={17} strokeWidth={2.2} />
						</IconButton>
					)}
					<IconButton label="Artifacts" variant="bar" render={<Link {...artifactsLink(pod)} />}>
						<Library size={16} strokeWidth={2} />
					</IconButton>
					<IconButton
						label="Pod settings"
						variant="bar"
						render={<Link {...podSettingsLink(pod)} state={backToChat} />}
					>
						<Settings2 size={16} strokeWidth={2} />
					</IconButton>
				</>
			}
		>
			{(shownChats || !empty) && (
				<ul
					className={cn(
						"m-0 flex min-h-0 list-none flex-col gap-px overflow-y-auto px-2 pt-2.5 pb-3",
						!empty && "flex-1",
					)}
				>
					{status === "failed" && (
						<li className="px-2.5 py-3 text-muted-foreground">Could not load these chats.</li>
					)}
					{shownChats && (
						<>
							<li className="flex items-center pr-1.5 pb-1 pl-2.5 font-medium text-[12px] text-subtle-foreground">
								<span className="flex-1">Chats</span>
								{chats && (
									<IconButton label={`New chat in ${pod.name}`} size="sm" onClick={chats.onNew}>
										<Plus strokeWidth={2.4} />
									</IconButton>
								)}
							</li>
							{shownChats.map((chat) => (
								<li key={chat === "unopened" ? "unopened" : chat.conversation.id}>
									<PodChatRow pod={pod} chat={chat} selected={isChatSelected(chat)} />
								</li>
							))}
							{!byBot && open.length > 0 && (
								<li className="px-2.5 pt-3.5 pb-1 font-medium text-[12px] text-subtle-foreground">
									Active threads
								</li>
							)}
						</>
					)}
					{byBot &&
						groupByBot(open, routines).map((group) => {
							// The open thread's section shows it, so the viewer can see where they are.
							const holdsSelected =
								group.threads.some((row) => isSelected(row.conversation.id)) ||
								group.routines.some((row) => isSelected(row.conversation?.id));
							const folded = foldedBots.has(group.key) && !holdsSelected;
							return (
								<BotSection
									key={group.key}
									pod={pod}
									group={group}
									folded={folded}
									onToggle={() => toggleBot(group.key)}
								>
									{group.threads.map((row) => (
										<li key={row.conversation.id}>
											<ConversationRow
												row={row}
												pod={pod}
												selected={isSelected(row.conversation.id)}
												grouped
											/>
										</li>
									))}
									{group.routines.map((row) => (
										<li key={row.routine.id}>
											<RoutineRow
												row={row}
												pod={pod}
												selected={isSelected(row.conversation?.id)}
												grouped
											/>
										</li>
									))}
								</BotSection>
							);
						})}
					{!byBot &&
						open.map((row) => (
							<li key={row.conversation.id}>
								<ConversationRow row={row} pod={pod} selected={isSelected(row.conversation.id)} />
							</li>
						))}
					{!byBot && routines.length > 0 && (
						<li className="pt-3.5">
							<SectionToggle
								label="Routines"
								count={routines.length}
								open={routinesShown}
								onOpenChange={setRoutinesShown}
							/>
						</li>
					)}
					{!byBot &&
						routinesShown &&
						routines.map((row) => (
							<li key={row.routine.id}>
								<RoutineRow row={row} pod={pod} selected={isSelected(row.conversation?.id)} />
							</li>
						))}
					{done.length > 0 && (
						<li className="pt-3.5">
							<SectionToggle
								label="Done"
								count={done.length}
								open={doneShown}
								onOpenChange={setDoneShown}
							/>
						</li>
					)}
					{doneShown &&
						done.map((row) => (
							<li key={row.conversation.id}>
								<ConversationRow row={row} pod={pod} selected={isSelected(row.conversation.id)} />
							</li>
						))}
				</ul>
			)}
			{empty && noBots}
		</ListColumn>
	);
}

/**
 * One of the pod's chats on one line, bright while something there is new,
 * with how much.
 */
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
	const lit = selected || unreadMessages > 0;
	return (
		<Link
			{...(chat === "unopened"
				? podChatLink(pod)
				: conversationLink({ pod, conversationId: chat.conversation.id }))}
			aria-current={selected ? "page" : undefined}
			className={rowClassName(selected)}
		>
			<PodChatTile color={pod.color} size={26} />
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-[14.5px]",
					lit ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
				)}
			>
				{chat === "unopened" ? FIRST_CHAT_NAME : chat.conversation.title}
			</span>
			<ChatMarker needsYou={false} unreadMessages={unreadMessages} />
		</Link>
	);
}

/**
 * A thread on one line: its bot's face, or the people's tile for one between
 * people, and its title, bright while something there is new or waits on the
 * viewer, and at the end what does.
 */
function ConversationRow({
	row,
	pod,
	selected,
	grouped = false,
}: {
	row: ChatListItem;
	pod: Pod;
	selected: boolean;
	/** Under its bot's heading, so marked as a thread rather than by whose it is. */
	grouped?: boolean;
}) {
	const { agent } = row;
	const needsYou = row.needsApproval || row.mentionsYou;
	const lit = selected || needsYou || row.unreadMessages > 0;
	// In a Personal pod a conversation is with the bot, so goes by its name and is never done.
	const direct = pod.kind === "personal";
	const done = !direct && row.conversation.doneAt !== null;
	return (
		<Link
			{...conversationLink({ pod, conversationId: row.conversation.id })}
			aria-current={selected ? "page" : undefined}
			className={rowClassName(selected)}
		>
			{grouped ? (
				<RowIcon>
					<MessageSquare />
				</RowIcon>
			) : agent ? (
				<AgentAvatar
					color={agent.color}
					face={agent.face}
					shape={agent.shape}
					size={26}
					className="shrink-0"
				/>
			) : (
				<PeopleTile />
			)}
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-[14.5px]",
					lit ? "font-semibold" : "font-medium",
					lit && !done ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{direct && agent ? agent.name : row.conversation.title}
			</span>
			<ChatMarker needsYou={needsYou} unreadMessages={row.unreadMessages} />
		</Link>
	);
}

/** A list row, shaded while it is the one open. */
function rowClassName(selected: boolean): string {
	return cn(
		"focus-ring flex min-h-10 items-center gap-3 rounded-tail px-2.5 transition-colors",
		selected ? "bg-row-selected" : "hover:bg-row-hover",
	);
}

/** A heading that folds the rows under it away, with how many there are. */
function SectionToggle({
	label,
	count,
	open,
	onOpenChange,
}: {
	label: string;
	count: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={() => onOpenChange(!open)}
			className="focus-ring flex w-full items-center gap-1.5 rounded-tail px-2.5 py-1 text-left font-medium text-[12px] text-subtle-foreground hover:text-muted-foreground"
		>
			<ChevronRight
				aria-hidden
				size={10}
				strokeWidth={2.6}
				className={cn("transition-transform duration-150", open && "rotate-90")}
			/>
			{label}
			<span>{count}</span>
		</button>
	);
}

/**
 * A routine on one line: the bot that runs it, its name, and at the end a red
 * dot when its latest run failed, that it is paused, or a dot when a message
 * in its thread mentions the viewer.
 */
function RoutineRow({
	row,
	pod,
	selected,
	grouped = false,
}: {
	row: ListedRoutine;
	pod: Pod;
	selected: boolean;
	/** Under its bot's heading, so marked as a routine rather than by whose it is. */
	grouped?: boolean;
}) {
	const { agent, routine } = row;
	return (
		<Link
			{...(row.conversation
				? conversationLink({ pod, conversationId: row.conversation.id })
				: routineThreadLink(pod, routine.id))}
			aria-current={selected ? "page" : undefined}
			className={rowClassName(selected)}
		>
			{grouped ? (
				<RowIcon>
					<RefreshCw />
				</RowIcon>
			) : (
				<AgentAvatar
					color={agent.color}
					face={agent.face}
					shape={agent.shape}
					size={26}
					className="shrink-0"
				/>
			)}
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-[14.5px]",
					selected || row.mentionsYou
						? "font-semibold text-foreground"
						: "font-medium text-muted-foreground",
				)}
			>
				{routine.name}
			</span>
			{routine.failed ? (
				<span className="mr-1.5 size-2 shrink-0 rounded-full bg-destructive-text">
					<span className="sr-only">Failed</span>
				</span>
			) : routine.state === "paused" ? (
				<span className="shrink-0 text-[12px] text-subtle-foreground">Paused</span>
			) : (
				<ChatMarker needsYou={row.mentionsYou} unreadMessages={0} />
			)}
		</Link>
	);
}

/** What a row is, in the place of the face its bot's heading already shows. */
function RowIcon({ children }: { children: ReactNode }) {
	return (
		<span
			aria-hidden
			className="grid size-[26px] shrink-0 place-items-center text-subtle-foreground [&_svg]:size-[15px]"
		>
			{children}
		</span>
	);
}

/** The header button that chooses between newest first and a section for each bot. */
function GroupingMenu({
	grouping,
	onGroupingChange,
}: {
	grouping: ListGrouping;
	onGroupingChange: (grouping: ListGrouping) => void;
}) {
	return (
		<DropdownMenu>
			<IconButton label="Group threads" variant="bar" render={<DropdownMenuTrigger />}>
				<ListFilter size={16} strokeWidth={2} />
			</IconButton>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuRadioGroup
					value={grouping}
					onValueChange={(value: ListGrouping) => onGroupingChange(value)}
				>
					<DropdownMenuRadioItem value="recent">Most recent</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="bot">By bot</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A bot's open threads, newest first, then its routines; or threads between people, when `agent` is null. */
interface BotGroup {
	key: string;
	agent: Agent | null;
	threads: ChatListItem[];
	routines: ListedRoutine[];
}

const PEOPLE_GROUP_KEY = "people";

/**
 * Sections for each bot with an open thread or a routine, in order of the
 * bots' names so each stays where it was as threads move, then the threads
 * between people.
 */
function groupByBot(
	threads: readonly ChatListItem[],
	routines: readonly ListedRoutine[],
): BotGroup[] {
	const groups = new Map<string, BotGroup>();
	const groupFor = (agent: Agent | null) => {
		const key = agent?.id ?? PEOPLE_GROUP_KEY;
		const existing = groups.get(key);
		if (existing) return existing;
		const group: BotGroup = { key, agent, threads: [], routines: [] };
		groups.set(key, group);
		return group;
	};
	for (const row of threads) groupFor(row.agent).threads.push(row);
	for (const row of routines) groupFor(row.agent).routines.push(row);
	return [...groups.values()].sort((a, b) => {
		if (!a.agent) return 1;
		if (!b.agent) return -1;
		return a.agent.name.localeCompare(b.agent.name);
	});
}

/**
 * A bot's heading, with its face and name, that folds its rows away, and a +
 * that starts a new thread with the bot. Folded, it says how many rows there
 * are, and with a dot whether a routine failed or a thread needs the viewer.
 */
function BotSection({
	pod,
	group,
	folded,
	onToggle,
	children,
}: {
	pod: Pod;
	group: BotGroup;
	folded: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	const { agent } = group;
	const count = group.threads.length + group.routines.length;
	const failed = group.routines.some((row) => row.routine.failed);
	const needsYou =
		group.threads.some((row) => row.needsApproval || row.mentionsYou) ||
		group.routines.some((row) => row.mentionsYou);
	return (
		<>
			<li className="flex items-center gap-1 pt-3.5 pr-1.5 pb-0.5">
				<button
					type="button"
					aria-expanded={!folded}
					onClick={onToggle}
					className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-tail py-1 pl-2.5 text-left font-semibold text-[13px] text-muted-foreground hover:text-foreground"
				>
					{agent ? (
						<AgentAvatar
							color={agent.color}
							face={agent.face}
							shape={agent.shape}
							size={18}
							className="shrink-0"
						/>
					) : (
						<Users aria-hidden size={15} strokeWidth={2} className="shrink-0" />
					)}
					<span className="min-w-0 flex-1 truncate">{agent ? agent.name : "People"}</span>
					{folded && (
						<span className="flex shrink-0 items-center gap-2 font-medium text-[12px] text-subtle-foreground">
							{count}
							{failed ? (
								<span className="size-2 rounded-full bg-destructive-text">
									<span className="sr-only">Failed</span>
								</span>
							) : (
								needsYou && (
									<span className="size-2 rounded-full bg-primary">
										<span className="sr-only">Needs you</span>
									</span>
								)
							)}
						</span>
					)}
					<ChevronRight
						aria-hidden
						size={12}
						strokeWidth={2.6}
						className={cn(
							"shrink-0 text-subtle-foreground transition-transform duration-150",
							!folded && "rotate-90",
						)}
					/>
				</button>
				<IconButton
					label={agent ? `New thread with ${agent.name}` : "New thread with people"}
					size="sm"
					render={<Link {...newThreadLink(pod, agent ?? undefined)} />}
				>
					<Plus strokeWidth={2.4} />
				</IconButton>
			</li>
			{!folded && children}
		</>
	);
}

/** Where a thread's row has no bot's face, as a thread between people does. */
function PeopleTile() {
	return (
		<span
			aria-hidden
			className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-chip-strong text-muted-foreground"
		>
			<Users size={14} strokeWidth={2} />
		</span>
	);
}

/**
 * What a chat's row says of it at its end: that it needs the viewer, as a
 * dot, otherwise how many messages are unread.
 */
function ChatMarker({
	needsYou,
	unreadMessages,
}: {
	/** A decision waits on the viewer, or an unread message mentions them. */
	needsYou: boolean;
	unreadMessages: number;
}) {
	if (needsYou) {
		return (
			<span className="mr-1.5 size-2 shrink-0 rounded-full bg-primary">
				<span className="sr-only">Needs you</span>
			</span>
		);
	}
	if (unreadMessages === 0) return null;
	return (
		<CountBadge
			count={unreadMessages}
			label={countOf(unreadMessages, "unread message", "unread messages")}
			size="md"
		/>
	);
}

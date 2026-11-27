import type { ChatStatus, ListedChat, Run } from "@sugabots/contracts";
import { useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import {
	Check,
	ChevronDown,
	Clock,
	Hand,
	LoaderCircle,
	MessageSquare,
	Reply,
	RotateCcw,
	Zap,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useProjectRuns } from "@/lib/automations.ts";
import { lastMovedAt, needsViewer, useProjectChats, useSetResolved } from "@/lib/chats.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import { useNow } from "@/lib/now.ts";
import {
	OwnerLink,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { outcomeOf, RunStatus } from "@/screens/AutomationRun.tsx";
import { AutomationTriggerIcon } from "@/screens/AutomationTriggerIcon.tsx";
import { ParticipantFaces } from "@/screens/ParticipantFaces.tsx";
import { formatElapsed } from "@/screens/tool-activity.ts";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { matchesSearch } from "@/ui/search-field.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";
import { Tooltip } from "@/ui/tooltip.tsx";

const HIDE_TIME_WHEN_ACTION_VISIBLE =
	"group-has-focus-visible/chat:invisible group-hover/chat:invisible [@media(hover:none)]:invisible";
const SHOW_CHAT_ACTION =
	"opacity-0 transition-opacity group-has-focus-visible/chat:opacity-100 group-hover/chat:opacity-100 [@media(hover:none)]:opacity-100";

/** How many of a section's chats or runs show before View all. */
const ENTRIES_SHOWN = 8;

/**
 * A bot's or a project's work: its open chats, those that need the viewer
 * among them, and its automations' runs, each newest first under a heading
 * that folds it away, and its resolved chats at the foot, folded until opened,
 * with `className` styling the scrolling part above them. `search` narrows every part to what has
 * it in a title or a name, and unfolds everything it finds. `work` is
 * `useOwnerWork(owner)`, read once by the page that shows it.
 */
export function OwnerWork({
	owner,
	work,
	selectedChatId,
	search = "",
	className,
}: {
	owner: ResourceOwner;
	work: OwnerWorkList;
	/** The chat open, marked in the list. */
	selectedChatId: string | undefined;
	search?: string;
	className?: string;
}) {
	const memberId = useSession().member?.id;
	const searching = search.trim() !== "";
	// The run its feed is open at, marked in the list.
	const runInView = useSearch({ strict: false, select: (params) => params.runChat });
	const { chats, runs } = work;
	const open = chats
		.filter((row) => row.chat.resolvedAt === null && chatMatches(row, search))
		.toSorted((a, b) => lastMovedAt(b) - lastMovedAt(a));
	// Newest first, as the API lists them.
	const shownRuns = runs.filter((run) => matchesSearch([run.automationName], search));
	const resolved = chats
		.filter((row) => row.chat.resolvedAt !== null && chatMatches(row, search))
		.toSorted((a, b) => lastMovedAt(b) - lastMovedAt(a));
	const nothing =
		!work.chatsFailed && open.length === 0 && shownRuns.length === 0 && resolved.length === 0;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className={cn("flex flex-col gap-3", className)}>
				{/* Sized as a row of the sidebar, as the pages above it are. */}
				{nothing && (
					<p className="m-0 flex h-8 items-center gap-2.5 pr-1.5 pl-2 text-sm text-subtle-foreground">
						<MessageSquare aria-hidden size={15} strokeWidth={1.75} className="shrink-0" />
						{searching ? "Nothing matches" : "No chats yet"}
					</p>
				)}
				{(open.length > 0 || work.chatsFailed) && (
					<WorkSection
						title="Chats"
						icon={<MessageSquare />}
						entries={open}
						searching={searching}
						note={work.chatsFailed ? "Could not load these chats." : undefined}
					>
						{(row) => (
							<li key={row.chat.id}>
								<ChatEntry
									row={row}
									owner={owner}
									memberId={memberId}
									selected={row.chat.id === selectedChatId}
								/>
							</li>
						)}
					</WorkSection>
				)}
				{shownRuns.length > 0 && (
					<WorkSection
						title="Automation runs"
						icon={<Zap />}
						entries={shownRuns}
						searching={searching}
					>
						{(run) => (
							<li key={run.id}>
								<RunEntry
									run={run}
									owner={owner}
									selected={run.rootChatId === selectedChatId && run.chatId === runInView}
								/>
							</li>
						)}
					</WorkSection>
				)}
			</div>
			{/* Resolved chats fold away at the foot, under everything still going. */}
			{resolved.length > 0 && (
				<div className="shrink-0 border-border border-t px-3 py-1">
					<WorkSection
						title="Resolved"
						icon={<Check />}
						entries={resolved}
						searching={searching}
						startsOpen={false}
						listClassName="max-h-72 overflow-y-auto"
					>
						{(row) => (
							<li key={row.chat.id}>
								<ResolvedEntry
									row={row}
									owner={owner}
									memberId={memberId}
									selected={row.chat.id === selectedChatId}
								/>
							</li>
						)}
					</WorkSection>
				</div>
			)}
		</div>
	);
}

/**
 * One part of the work under a heading that folds it away, with how many it
 * holds: the first few of `entries`, then a button that shows the rest. A
 * search unfolds it and shows all it found.
 */
function WorkSection<Entry>({
	title,
	icon,
	entries,
	searching,
	note,
	startsOpen = true,
	listClassName,
	children,
}: {
	title: string;
	/** The mark before its heading, as the sidebar's pages have. */
	icon: ReactNode;
	/** Whether it starts unfolded; folded starts it closed until opened. */
	startsOpen?: boolean;
	listClassName?: string;
	entries: readonly Entry[];
	searching: boolean;
	/** Said under the entries, such as why some could not be loaded. */
	note?: string;
	children: (entry: Entry) => ReactNode;
}) {
	const [open, setOpen] = useState(startsOpen);
	const [allShown, setAllShown] = useState(false);
	const unfolded = open || searching;
	const shown = allShown || searching ? entries : entries.slice(0, ENTRIES_SHOWN);
	const labelId = useId();
	return (
		<section aria-labelledby={labelId} className="flex flex-col gap-1">
			<h2 className="m-0 font-normal text-xs">
				{searching ? (
					// A search shows everything it found, so there is nothing to fold.
					<span className="flex h-7 items-center gap-2 px-2 text-subtle-foreground [&_svg]:size-3.25">
						{icon}
						<span id={labelId} className="flex-1">
							{title}
						</span>
						<span className="tabular-nums">{entries.length}</span>
					</span>
				) : (
					<Button
						variant="quiet"
						size="text"
						aria-expanded={open}
						onClick={() => setOpen(!open)}
						className="h-7 w-full gap-2 rounded-sm px-2 [&_svg]:size-3.25"
					>
						{icon}
						<span id={labelId} className="flex-1 text-left">
							{title}
						</span>
						<span className="tabular-nums">{entries.length}</span>
						<ChevronDown
							aria-hidden
							strokeWidth={2}
							className={cn(
								"size-3.25 transition-transform motion-reduce:transition-none",
								!open && "-rotate-90",
							)}
						/>
					</Button>
				)}
			</h2>
			{unfolded && (
				<ul className={cn("m-0 flex list-none flex-col gap-px p-0", listClassName)}>
					{shown.map(children)}
					{note && <li className="px-2 py-1 text-subtle-foreground text-xs">{note}</li>}
					{!searching && entries.length > ENTRIES_SHOWN && (
						<li>
							<Button
								variant="quiet"
								size="text"
								aria-expanded={allShown}
								onClick={() => setAllShown(!allShown)}
								className="mt-1 px-2"
							>
								{allShown ? "Show fewer" : "View all"}
							</Button>
						</li>
					)}
				</ul>
			)}
		</section>
	);
}

/**
 * The chats of a bot or project, resolved ones among them,
 * and the latest runs of its automations, with whether one of its automations
 * is failing (see `AutomationListStatus.failing`).
 */
export function useOwnerWork(owner: ResourceOwner): OwnerWorkList {
	const list = useProjectChats(resourceProjectId(owner));
	const runs = useProjectRuns(resourceProjectId(owner));
	// Without how it stands, for somebody who may not read its runs, one that paused itself is still failing.
	const automationFailing = (list.data?.automations ?? []).some(
		(row) => row.status?.failing ?? row.automation.pausedAfterFailures,
	);
	return {
		chats: list.data?.chats ?? [],
		chatsFailed: list.isError,
		runs,
		automationFailing,
	};
}

/** What `useOwnerWork` reads for a bot or a project. */
type OwnerWorkList = {
	chats: readonly ListedChat[];
	chatsFailed: boolean;
	runs: Run[];
	automationFailing: boolean;
};

/**
 * One of the open chats, on three lines: how many messages it holds, with
 * when it last moved at the end, or Needs you while it waits on the viewer,
 * or Working while a bot works in it; its title; then the faces of who is
 * talking in it, with what its bots are doing at the end, left out when there
 * is neither. Pointed at, Resolve takes the time's place, for a member who
 * may resolve it.
 */
function ChatEntry({
	row,
	owner,
	memberId,
	selected,
}: {
	row: ListedChat;
	owner: ResourceOwner;
	memberId: string | undefined;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	const setResolved = useSetResolved(row.chat.id);
	const mayResolve = resourcePermissions(owner).resolveChats;
	const { chat } = row;
	const members = row.participants.filter((participant) => participant.kind === "member");
	const talking =
		members.length === 0
			? "No one yet"
			: members.map((member) => (member.id === memberId ? "You" : member.name)).join(", ");
	const unread = row.unreadMessages > 0;
	const movedAt = new Date(lastMovedAt(row));
	const needsYou = needsViewer(row);
	// Needing the viewer, or working, it says so where the time is; waiting and replied go under the title.
	const working = row.status?.kind === "working" ? row.status : undefined;
	const inTimesPlace = needsYou ? (
		<NeedsYouLabel approval={row.needsApproval} />
	) : (
		working && <ChatStatusLabel status={working} />
	);
	// Waiting on the viewer's approval is what Needs you already says.
	const waitingOnViewer = needsYou && row.status?.kind === "waiting";
	const statusBelow = working || waitingOnViewer ? undefined : row.status;
	return (
		// The row is its link; Resolve sits over the link's corner, as a button can't be inside a link.
		<div className="group/chat relative">
			<OwnerLink
				owner={owner}
				to={{ page: "chat", chatId: chat.id }}
				aria-current={selected ? "page" : undefined}
				onDoubleClick={hideSidebar}
				className={cn(
					"focus-ring flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 transition-colors",
					selected ? "bg-row-selected" : "group-hover/chat:bg-row-hover",
				)}
			>
				{/* First to be read, so the link is named by it; shown under the count and time. */}
				<span
					className={cn(
						"order-2 min-w-0 truncate text-sm leading-snug",
						unread ? "font-semibold text-foreground" : "text-soft-foreground",
					)}
				>
					{chat.title}
				</span>
				<span className="order-1 flex h-5 min-w-0 items-center justify-between gap-2">
					<MessageCount count={row.messageCount} />
					{/* Its place goes to Resolve while the row is pointed at, so it is held as wide as Resolve. */}
					{inTimesPlace ? (
						<span
							className={cn(
								"flex h-5 min-w-17 shrink-0 items-center justify-end",
								mayResolve && HIDE_TIME_WHEN_ACTION_VISIBLE,
							)}
						>
							{inTimesPlace}
						</span>
					) : (
						<time
							dateTime={movedAt.toISOString()}
							className={cn(
								"flex h-5 min-w-17 shrink-0 items-center justify-end text-subtle-foreground text-xs tabular-nums",
								mayResolve && HIDE_TIME_WHEN_ACTION_VISIBLE,
							)}
						>
							{formatListTime(movedAt, new Date())}
						</time>
					)}
				</span>
				{/* Who is talking, by their names, for whoever can't see the faces. */}
				<span className="sr-only">{talking}</span>
				{(statusBelow || members.length > 0) && (
					<span className="order-3 flex h-4 min-w-0 items-center justify-between gap-1.5">
						{members.length > 0 && (
							<span aria-hidden className="flex shrink-0">
								<ParticipantFaces
									participants={members}
									shown={4}
									size={16}
									surface="var(--rail)"
								/>
							</span>
						)}
						{statusBelow && (
							<span className="ml-auto flex min-w-0">
								<ChatStatusLabel status={statusBelow} />
							</span>
						)}
					</span>
				)}
			</OwnerLink>
			{mayResolve && (
				<Button
					variant="ghost"
					size="sm"
					disabled={setResolved.isPending}
					onClick={() => setResolved.mutate(true)}
					aria-label={`Resolve: ${chat.title}`}
					className={cn(
						"absolute top-1.5 right-0.5 h-6 gap-1 px-1.5 font-normal text-subtle-foreground text-xs tabular-nums ",
						SHOW_CHAT_ACTION,
					)}
				>
					Resolve
					<Check aria-hidden strokeWidth={2.25} className="size-3" />
				</Button>
			)}
		</div>
	);
}

/**
 * A resolved chat, kept quiet: who is in it, its title and when it last moved, on
 * one line, the rest said when it is pointed at. Pointed at, Reopen takes
 * the time's place, for a member who may reopen it.
 */
function ResolvedEntry({
	row,
	owner,
	memberId,
	selected,
}: {
	row: ListedChat;
	owner: ResourceOwner;
	memberId: string | undefined;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	const setResolved = useSetResolved(row.chat.id);
	const mayReopen = resourcePermissions(owner).resolveChats;
	const members = row.participants.filter((participant) => participant.kind === "member");
	const talking = members
		.map((member) => (member.id === memberId ? "You" : member.name))
		.join(", ");
	const movedAt = new Date(lastMovedAt(row));
	const about = [talking, countOf(row.messageCount, "message", "messages")]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="group/chat relative">
			<Tooltip label={about} side="right" align="start">
				<OwnerLink
					owner={owner}
					to={{ page: "chat", chatId: row.chat.id }}
					aria-current={selected ? "page" : undefined}
					onDoubleClick={hideSidebar}
					className={cn(
						sidebarRow({ selected, radius: "md" }),
						// Shaded while Reopen, over its end, is pointed at too.
						!selected &&
							"text-subtle-foreground hover:text-soft-foreground group-hover/chat:bg-row-hover group-hover/chat:text-soft-foreground",
					)}
				>
					<span aria-hidden className="flex shrink-0 opacity-70">
						{members.length > 0 ? (
							<ParticipantFaces participants={members} shown={1} size={16} surface="var(--rail)" />
						) : (
							<MessageSquare size={14} strokeWidth={1.75} />
						)}
					</span>
					<span className="min-w-0 flex-1 truncate">{row.chat.title}</span>
					{/* Its place goes to Reopen while the row is pointed at. */}
					<time
						dateTime={movedAt.toISOString()}
						className={cn(
							"shrink-0 text-xs tabular-nums",
							mayReopen && HIDE_TIME_WHEN_ACTION_VISIBLE,
						)}
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</OwnerLink>
			</Tooltip>
			{mayReopen && (
				<IconButton
					label={`Reopen: ${row.chat.title}`}
					disabled={setResolved.isPending}
					onClick={() => setResolved.mutate(false)}
					className={cn(
						"absolute top-1 right-1 rounded-md text-subtle-foreground ",
						SHOW_CHAT_ACTION,
					)}
				>
					<RotateCcw aria-hidden strokeWidth={2} />
				</IconButton>
			)}
		</div>
	);
}

/**
 * One run of the automations: how it went and when, and its automation's
 * name. It opens its automation's feed at the run.
 */
function RunEntry({ run, owner, selected }: { run: Run; owner: ResourceOwner; selected: boolean }) {
	const hideSidebar = useHideSidebar();
	const at = run.finishedAt ?? run.startedAt ?? run.acceptedAt;
	return (
		<OwnerLink
			owner={owner}
			to={{ page: "chat", chatId: run.rootChatId, runChat: run.chatId }}
			aria-current={selected ? "page" : undefined}
			onDoubleClick={hideSidebar}
			className={cn(
				"focus-ring flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<span className="flex min-w-0 items-center gap-1.5 text-subtle-foreground text-xs">
				<AutomationTriggerIcon
					kind={run.trigger.kind}
					aria-hidden
					size={12}
					strokeWidth={1.75}
					className="shrink-0"
				/>
				<RunStatus outcome={outcomeOf(run.state, run.posted)} />
				<span className="flex-1" />
				<time dateTime={at} className="shrink-0 tabular-nums">
					{formatListTime(new Date(at), new Date())}
				</time>
			</span>
			<span className="min-w-0 break-words text-soft-foreground text-sm leading-snug">
				{run.automationName}
			</span>
			<span className="text-subtle-foreground text-xs">Automation run</span>
		</OwnerLink>
	);
}

/** Whether a chat's title, or the name of somebody in it, has `search` in it, whatever its case. */
function chatMatches(row: ListedChat, search: string): boolean {
	return matchesSearch(
		[row.chat.title, ...row.participants.map((participant) => participant.name)],
		search,
	);
}

/**
 * What a chat's bots are doing, as its row says it: "Working 12s" with a
 * spinner while a turn works on a reply, counting up each second; "Waiting
 * 2m" with a clock while one waits on an approval, counting up each minute;
 * or a green Replied once a bot finished a reply the viewer has not read.
 */
function ChatStatusLabel({ status }: { status: ChatStatus }) {
	const label = "flex min-w-0 items-center gap-1 text-xs tabular-nums";
	switch (status.kind) {
		case "working":
			return (
				<span className={cn(label, "text-working")}>
					<LoaderCircle aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
					<span className="truncate">
						Working <Elapsed since={status.since} inSeconds />
					</span>
				</span>
			);
		case "waiting":
			return (
				<span className={cn(label, "text-subtle-foreground")}>
					<Clock aria-hidden className="size-3 shrink-0" />
					<span className="truncate">
						Waiting <Elapsed since={status.since} />
					</span>
				</span>
			);
		case "replied":
			return (
				<span className={cn(label, "text-success-text")}>
					<Reply aria-hidden className="size-3 shrink-0" />
					Replied
				</span>
			);
	}
}

/**
 * A chat waiting on the viewer, as its row says it: a waving hand and Needs
 * you, in the colour the rail's dot for it has, telling a screen reader
 * whether it waits on their approval or their reply.
 */
function NeedsYouLabel({ approval }: { approval: boolean }) {
	return (
		<span className="flex min-w-0 items-center gap-1 text-warning text-xs">
			<Hand
				aria-hidden
				strokeWidth={2}
				className="size-3 shrink-0 origin-bottom motion-safe:animate-wave"
			/>
			<span className="truncate">
				Needs you<span className="sr-only">{approval ? " to approve" : " to reply"}</span>
			</span>
		</span>
	);
}

/**
 * How long since `since`, an ISO time, counting up while shown: as "20m", or
 * `inSeconds` as "12s", then "1m 5s".
 */
function Elapsed({ since, inSeconds = false }: { since: string; inSeconds?: boolean }) {
	const now = useNow(inSeconds ? SECOND_MS : MINUTE_MS);
	const elapsedMs = now - Date.parse(since);
	return <>{inSeconds ? formatElapsed(elapsedMs) : formatElapsedMinutes(elapsedMs)}</>;
}

const SECOND_MS = 1_000;

const MINUTE_MS = 60_000;

const MINUTES_IN_HOUR = 60;
const HOURS_IN_DAY = 24;

/** `ms` as a status line counts it: "<1m", "20m", "3h", then "2d", each rounded down. */
function formatElapsedMinutes(ms: number): string {
	const minutes = Math.floor(ms / MINUTE_MS);
	if (minutes < 1) return "<1m";
	if (minutes < MINUTES_IN_HOUR) return `${minutes}m`;
	const hours = Math.floor(minutes / MINUTES_IN_HOUR);
	if (hours < HOURS_IN_DAY) return `${hours}h`;
	return `${Math.floor(hours / HOURS_IN_DAY)}d`;
}

/** How many messages a chat holds, as a quiet count with a speech mark. */
function MessageCount({ count }: { count: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1 text-subtle-foreground text-xs tabular-nums">
			<MessageSquare aria-hidden size={12} strokeWidth={1.75} />
			<span aria-hidden>{count}</span>
			<span className="sr-only">{countOf(count, "message", "messages")}</span>
		</span>
	);
}

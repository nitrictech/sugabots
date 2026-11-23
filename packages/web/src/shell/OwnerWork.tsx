import type { ListedThread, Run, ThreadActivity } from "@sugabots/contracts";
import { useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import {
	Check,
	ChevronDown,
	CircleCheck,
	Clock,
	LoaderCircle,
	MessageSquare,
	RotateCcw,
	Zap,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useProjectRuns } from "@/lib/automations.ts";
import { lastMovedAt, needsViewer, useProjectThreads, useSetDone } from "@/lib/chats.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import { useNow } from "@/lib/now.ts";
import { OwnerLink, type ResourceOwner, resourceProjectId } from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { outcomeOf, RunStatus } from "@/screens/AutomationRun.tsx";
import { ParticipantFaces } from "@/screens/ParticipantFaces.tsx";
import { AutomationTriggerIcon } from "@/screens/RunRow.tsx";
import { AttentionDot } from "@/ui/attention-dot.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { matchesSearch } from "@/ui/search-field.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";
import { Tooltip } from "@/ui/tooltip.tsx";

/** How many of a section's threads or runs show before View all. */
const ENTRIES_SHOWN = 8;

/**
 * A bot's or a project's work: the threads that need the viewer, then its
 * open threads and its automations' runs, each newest first under a heading
 * that folds it away, and its done threads at the foot, folded until opened,
 * with `className` styling the scrolling part above them. `search` narrows every part to what has
 * it in a title or a name, and unfolds everything it finds. `work` is
 * `useOwnerWork(owner)`, read once by the page that shows it.
 */
export function OwnerWork({
	owner,
	work,
	selectedConversationId,
	search = "",
	className,
}: {
	owner: ResourceOwner;
	work: OwnerWorkList;
	/** The thread open, marked in the list. */
	selectedConversationId: string | undefined;
	search?: string;
	className?: string;
}) {
	const userId = useSession().user?.id;
	const searching = search.trim() !== "";
	// A run open as a page of its automation's, marked in the list.
	const openRun = useSearch({ strict: false, select: (params) => params.itemPage });
	const { threads, runs } = work;
	const needsYou = threads.filter((row) => needsViewer(row) && threadMatches(row, search));
	const open = threads
		.filter(
			(row) =>
				row.conversation.doneAt === null && !needsYou.includes(row) && threadMatches(row, search),
		)
		.toSorted((a, b) => lastMovedAt(b) - lastMovedAt(a));
	// Newest first, as the API lists them.
	const shownRuns = runs.filter((run) => matchesSearch([run.automationName], search));
	const done = threads
		.filter((row) => row.conversation.doneAt !== null && threadMatches(row, search))
		.toSorted((a, b) => lastMovedAt(b) - lastMovedAt(a));
	const nothing =
		!work.threadsFailed &&
		needsYou.length === 0 &&
		open.length === 0 &&
		shownRuns.length === 0 &&
		done.length === 0;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className={cn("flex flex-col gap-3", className)}>
				{needsYou.length > 0 && (
					<section className="flex flex-col gap-1">
						<h2 className="m-0 px-2 pb-1 font-normal text-subtle-foreground text-xs">Needs you</h2>
						<ul className="m-0 flex list-none flex-col gap-px p-0">
							{needsYou.map((row) => (
								<li key={row.conversation.id}>
									<NeedsYouRow
										row={row}
										owner={owner}
										selected={row.conversation.id === selectedConversationId}
									/>
								</li>
							))}
						</ul>
					</section>
				)}
				{/* Sized as a row of the sidebar, as the pages above it are. */}
				{nothing && (
					<p className="m-0 flex h-8 items-center gap-2.5 pr-1.5 pl-2 text-sm text-subtle-foreground">
						<MessageSquare aria-hidden size={15} strokeWidth={1.75} className="shrink-0" />
						{searching ? "Nothing matches" : "No threads yet"}
					</p>
				)}
				{(open.length > 0 || work.threadsFailed) && (
					<WorkSection
						title="Threads"
						icon={<MessageSquare />}
						entries={open}
						searching={searching}
						note={work.threadsFailed ? "Could not load these threads." : undefined}
					>
						{(row) => (
							<li key={row.conversation.id}>
								<ThreadEntry
									row={row}
									owner={owner}
									userId={userId}
									selected={row.conversation.id === selectedConversationId}
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
								<RunEntry run={run} owner={owner} selected={run.conversationId === openRun} />
							</li>
						)}
					</WorkSection>
				)}
			</div>
			{/* Done threads fold away at the foot, under everything still going. */}
			{done.length > 0 && (
				<div className="shrink-0 border-border border-t px-3 py-1">
					<WorkSection
						title="Done"
						icon={<Check />}
						entries={done}
						searching={searching}
						startsOpen={false}
						listClassName="max-h-72 overflow-y-auto"
					>
						{(row) => (
							<li key={row.conversation.id}>
								<DoneEntry
									row={row}
									owner={owner}
									userId={userId}
									selected={row.conversation.id === selectedConversationId}
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
 * The threads of a bot or project, those not archived, done ones among them,
 * and the latest runs of its automations, with whether one of its automations
 * is failing (see `AutomationListStatus.failing`).
 */
export function useOwnerWork(owner: ResourceOwner): OwnerWorkList {
	const list = useProjectThreads(resourceProjectId(owner));
	const runs = useProjectRuns(resourceProjectId(owner));
	// Without how it stands, for somebody who may not read its runs, one that paused itself is still failing.
	const automationFailing = (list.data?.automations ?? []).some(
		(row) => row.status?.failing ?? row.automation.pausedAfterFailures,
	);
	return {
		threads: list.data?.threads ?? [],
		threadsFailed: list.isError,
		runs,
		automationFailing,
	};
}

/** What `useOwnerWork` reads for a bot or a project. */
type OwnerWorkList = {
	threads: readonly ListedThread[];
	threadsFailed: boolean;
	runs: Run[];
	automationFailing: boolean;
};

/** A thread waiting on the viewer, on one line: a dot, then its title. */
function NeedsYouRow({
	row,
	owner,
	selected,
}: {
	row: ListedThread;
	owner: ResourceOwner;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	return (
		<OwnerLink
			owner={owner}
			to={{ page: "thread", conversationId: row.conversation.id }}
			aria-current={selected ? "page" : undefined}
			onDoubleClick={hideSidebar}
			className={sidebarRow({ selected, radius: "md" })}
		>
			<span className="grid w-3 shrink-0 place-items-center">
				<AttentionDot attention="needsYou" />
			</span>
			<span className="min-w-0 flex-1 truncate">{row.conversation.title}</span>
			<span className="sr-only">
				{row.needsApproval ? ", needs your approval" : ", mentions you"}
			</span>
		</OwnerLink>
	);
}

/**
 * One of the open threads, on three lines: how many messages it holds, with
 * when it last moved at the end; its title; then the faces of who is talking
 * in it, with what its bots are doing at the end, left out when there is
 * neither. Pointed at, Done takes the time's place.
 */
function ThreadEntry({
	row,
	owner,
	userId,
	selected,
}: {
	row: ListedThread;
	owner: ResourceOwner;
	userId: string | undefined;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	const setDone = useSetDone(row.conversation.id);
	const { conversation } = row;
	const people = row.participants.filter((participant) => participant.kind === "person");
	const talking =
		people.length === 0
			? "No one yet"
			: people.map((person) => (person.id === userId ? "You" : person.name)).join(", ");
	const unread = row.unreadMessages > 0;
	const movedAt = new Date(lastMovedAt(row));
	return (
		// The row is its link; Done sits over the link's corner, as a button can't be inside a link.
		<div className="group/thread relative">
			<OwnerLink
				owner={owner}
				to={{ page: "thread", conversationId: conversation.id }}
				aria-current={selected ? "page" : undefined}
				onDoubleClick={hideSidebar}
				className={cn(
					"focus-ring flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 transition-colors",
					selected ? "bg-row-selected" : "group-hover/thread:bg-row-hover",
				)}
			>
				{/* First to be read, so the link is named by it; shown under the count and time. */}
				<span
					className={cn(
						"order-2 min-w-0 truncate text-sm leading-snug",
						unread ? "font-semibold text-foreground" : "text-soft-foreground",
					)}
				>
					{conversation.title}
				</span>
				<span className="order-1 flex h-5 min-w-0 items-center justify-between gap-2">
					<MessageCount count={row.messageCount} />
					{/* Its place goes to Done while the row is pointed at, so it is held as wide as Done. */}
					<time
						dateTime={movedAt.toISOString()}
						className="flex h-5 min-w-14 shrink-0 items-center justify-end text-subtle-foreground text-xs tabular-nums group-has-focus-visible/thread:invisible group-hover/thread:invisible [@media(hover:none)]:invisible"
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</span>
				{/* Who is talking, by their names, for whoever can't see the faces. */}
				<span className="sr-only">{talking}</span>
				{(row.activity || people.length > 0) && (
					<span className="order-3 flex h-4 min-w-0 items-center justify-between gap-1.5">
						{people.length > 0 && (
							<span aria-hidden className="flex shrink-0">
								<ParticipantFaces participants={people} shown={4} size={16} surface="var(--rail)" />
							</span>
						)}
						{row.activity && (
							<span className="ml-auto flex min-w-0">
								<ThreadActivityLabel activity={row.activity} />
							</span>
						)}
					</span>
				)}
			</OwnerLink>
			<Button
				variant="ghost"
				size="sm"
				disabled={setDone.isPending}
				onClick={() => setDone.mutate(true)}
				aria-label={`Done: ${conversation.title}`}
				className="absolute top-1.5 right-0.5 h-6 gap-1 px-1.5 font-normal text-subtle-foreground text-xs tabular-nums opacity-0 transition-opacity group-has-focus-visible/thread:opacity-100 group-hover/thread:opacity-100 [@media(hover:none)]:opacity-100"
			>
				Done
				<Check aria-hidden strokeWidth={2.25} className="size-3" />
			</Button>
		</div>
	);
}

/**
 * A done thread, kept quiet: who is in it, its title and when it last moved, on
 * one line, the rest said when it is pointed at. Pointed at, Reopen takes
 * the time's place.
 */
function DoneEntry({
	row,
	owner,
	userId,
	selected,
}: {
	row: ListedThread;
	owner: ResourceOwner;
	userId: string | undefined;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	const setDone = useSetDone(row.conversation.id);
	const people = row.participants.filter((participant) => participant.kind === "person");
	const talking = people.map((person) => (person.id === userId ? "You" : person.name)).join(", ");
	const movedAt = new Date(lastMovedAt(row));
	const about = [talking, countOf(row.messageCount, "message", "messages")]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="group/thread relative">
			<Tooltip label={about} side="right" align="start">
				<OwnerLink
					owner={owner}
					to={{ page: "thread", conversationId: row.conversation.id }}
					aria-current={selected ? "page" : undefined}
					onDoubleClick={hideSidebar}
					className={cn(
						sidebarRow({ selected, radius: "md" }),
						// Shaded while Reopen, over its end, is pointed at too.
						!selected &&
							"text-subtle-foreground hover:text-soft-foreground group-hover/thread:bg-row-hover group-hover/thread:text-soft-foreground",
					)}
				>
					<span aria-hidden className="flex shrink-0 opacity-70">
						{people.length > 0 ? (
							<ParticipantFaces participants={people} shown={1} size={16} surface="var(--rail)" />
						) : (
							<MessageSquare size={14} strokeWidth={1.75} />
						)}
					</span>
					<span className="min-w-0 flex-1 truncate">{row.conversation.title}</span>
					{/* Its place goes to Reopen while the row is pointed at. */}
					<time
						dateTime={movedAt.toISOString()}
						className="shrink-0 text-xs tabular-nums group-has-focus-visible/thread:invisible group-hover/thread:invisible [@media(hover:none)]:invisible"
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</OwnerLink>
			</Tooltip>
			<IconButton
				label={`Reopen: ${row.conversation.title}`}
				disabled={setDone.isPending}
				onClick={() => setDone.mutate(false)}
				className="absolute top-1 right-1 rounded-md text-subtle-foreground opacity-0 transition-opacity group-has-focus-visible/thread:opacity-100 group-hover/thread:opacity-100 [@media(hover:none)]:opacity-100"
			>
				<RotateCcw aria-hidden strokeWidth={2} />
			</IconButton>
		</div>
	);
}

/**
 * One run of the automations: how it went and when, and its automation's
 * name. It opens as a page of its automation's.
 */
function RunEntry({ run, owner, selected }: { run: Run; owner: ResourceOwner; selected: boolean }) {
	const hideSidebar = useHideSidebar();
	const at = run.finishedAt ?? run.startedAt ?? run.acceptedAt;
	return (
		<OwnerLink
			owner={owner}
			to={{ page: "automation", automationId: run.automationId, itemPage: run.conversationId }}
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

/** Whether a thread's title, or the name of somebody in it, has `search` in it, whatever its case. */
function threadMatches(row: ListedThread, search: string): boolean {
	return matchesSearch(
		[row.conversation.title, ...row.participants.map((participant) => participant.name)],
		search,
	);
}

/**
 * What a thread's bots are doing, as its row says it: "Working 20m" with a
 * spinner while a turn works on a reply, "Waiting 2m" with a clock while one
 * waits on an approval, each counting up a minute at a time; or a green Done
 * once a bot finished a reply the viewer has not read.
 */
function ThreadActivityLabel({ activity }: { activity: ThreadActivity }) {
	const label = "flex min-w-0 items-center gap-1 text-xs tabular-nums";
	switch (activity.kind) {
		case "working":
			return (
				<span className={cn(label, "text-working")}>
					<LoaderCircle aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
					<span className="truncate">
						Working <Elapsed since={activity.since} />
					</span>
				</span>
			);
		case "waiting":
			return (
				<span className={cn(label, "text-subtle-foreground")}>
					<Clock aria-hidden className="size-3 shrink-0" />
					<span className="truncate">
						Waiting <Elapsed since={activity.since} />
					</span>
				</span>
			);
		case "finished":
			return (
				<span className={cn(label, "text-success-text")}>
					<CircleCheck aria-hidden className="size-3 shrink-0" />
					Done
				</span>
			);
	}
}

/** How long since `since`, an ISO time, as "20m", counting up while shown. */
function Elapsed({ since }: { since: string }) {
	const now = useNow(MINUTE_MS);
	return <>{formatElapsedMinutes(now - Date.parse(since))}</>;
}

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

/** How many messages a thread holds, as a quiet count with a speech mark. */
function MessageCount({ count }: { count: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1 text-subtle-foreground text-xs tabular-nums">
			<MessageSquare aria-hidden size={12} strokeWidth={1.75} />
			<span aria-hidden>{count}</span>
			<span className="sr-only">{countOf(count, "message", "messages")}</span>
		</span>
	);
}

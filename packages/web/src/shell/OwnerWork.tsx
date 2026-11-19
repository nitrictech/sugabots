import type { ListedThread, Run } from "@sugabots/contracts";
import { useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { CalendarClock, Check, ChevronDown, MessageSquare, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useAutomations, useProjectRuns } from "@/lib/automations.ts";
import { lastMovedAt, useBotThreads, useProjectThreads, useSetDone } from "@/lib/chats.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import {
	OwnerLink,
	ownerName,
	type ResourceOwner,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { ParticipantFaces } from "@/screens/ParticipantFaces.tsx";
import { AttentionDot } from "@/ui/attention-dot.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";
import { Tooltip } from "@/ui/tooltip.tsx";

/** How many threads and runs show before View all. */
const ENTRIES_SHOWN = 8;

/** How many done threads show at first, and how many more each Show more adds. */
const RESOLVED_SHOWN = { first: 10, more: 25 };

/** Which of the work is listed: all of it, the threads, or the automations' runs. */
export type Showing = "all" | "threads" | "runs";

export const SHOWING_LABELS: Record<Showing, string> = {
	all: "All",
	threads: "Threads",
	runs: "Automation runs",
};

/** One of the threads, or one run of the automations, by when it last moved. */
type Entry =
	| { kind: "thread"; row: ListedThread; at: number }
	| { kind: "run"; run: Run; at: number };

/**
 * A bot's or a project's work: the threads that need the viewer, then its
 * open threads and its automations' runs together, newest first, and its
 * done threads folded away under them. `search` narrows every part to what
 * has it in a title or a name, and opens everything it finds; `showing`
 * narrows it to the threads or the runs.
 */
export function OwnerWork({
	owner,
	selectedConversationId,
	search = "",
	showing = "all",
	className,
}: {
	owner: ResourceOwner;
	/** The thread open, marked in the list. */
	selectedConversationId: string | undefined;
	search?: string;
	showing?: Showing;
	className?: string;
}) {
	const work = useOwnerWork(owner);
	const userId = useSession().user?.id;
	const name = ownerName(owner);
	const [allShown, setAllShown] = useState(false);
	const searching = search.trim() !== "";
	// A run open as a page of its automation's, marked in the list.
	const openRun = useSearch({ strict: false, select: (params) => params.itemPage });
	const { threads, runs } = work;
	const needsYou = threads.filter(
		(row) =>
			row.conversation.doneAt === null &&
			(row.needsApproval || row.mentionsYou) &&
			matches(row, search),
	);
	const entries: Entry[] = [
		...(showing === "runs"
			? []
			: threads
					.filter(
						(row) =>
							row.conversation.doneAt === null && !needsYou.includes(row) && matches(row, search),
					)
					.map((row): Entry => ({ kind: "thread", row, at: lastMovedAt(row) }))),
		...(showing === "threads"
			? []
			: runs
					.filter((run) => includesFolded(run.automationName, search))
					.map((run): Entry => ({ kind: "run", run, at: Date.parse(run.acceptedAt) }))),
	].toSorted((a, b) => b.at - a.at);
	const shown = allShown || searching ? entries : entries.slice(0, ENTRIES_SHOWN);
	const [resolvedOpen, setResolvedOpen] = useState(true);
	const [resolvedShown, setResolvedShown] = useState(RESOLVED_SHOWN.first);
	const resolved =
		showing === "runs"
			? []
			: threads
					.filter((row) => row.conversation.doneAt !== null && matches(row, search))
					.toSorted((a, b) => lastMovedAt(b) - lastMovedAt(a));
	const resolvedUnfolded = resolvedOpen || searching;
	return (
		<div className={cn("flex flex-col gap-5", className)}>
			{needsYou.length > 0 && showing !== "runs" && (
				<section className="flex flex-col gap-1">
					<h3 className="m-0 px-2 pb-1 font-normal text-subtle-foreground text-xs">Needs you</h3>
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
			<ul aria-label={`${name}'s work`} className="m-0 flex list-none flex-col gap-px p-0">
				{shown.map((entry) =>
					entry.kind === "thread" ? (
						<li key={entry.row.conversation.id}>
							<ThreadEntry
								row={entry.row}
								owner={owner}
								userId={userId}
								selected={entry.row.conversation.id === selectedConversationId}
							/>
						</li>
					) : (
						<li key={entry.run.id}>
							<RunEntry
								run={entry.run}
								owner={owner}
								selected={entry.run.conversationId === openRun}
							/>
						</li>
					),
				)}
				{work.threadsFailed && (
					<li className="px-2 py-1 text-subtle-foreground text-xs">
						Could not load these threads.
					</li>
				)}
				{!work.threadsFailed &&
					entries.length === 0 &&
					resolved.length === 0 &&
					needsYou.length === 0 && (
						<li className="px-2 py-1 text-subtle-foreground text-xs">
							{searching
								? "Nothing matches."
								: showing === "runs"
									? "No automation runs yet."
									: "No threads yet."}
						</li>
					)}
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
			{resolved.length > 0 && (
				<section className="flex flex-col gap-1">
					<button
						type="button"
						aria-expanded={resolvedUnfolded}
						onClick={() => setResolvedOpen(!resolvedOpen)}
						className="focus-ring flex h-7 items-center gap-2 rounded-sm px-2 text-subtle-foreground text-xs transition-colors hover:text-foreground"
					>
						<span className="flex-1 text-left">Done</span>
						<span className="tabular-nums">{resolved.length}</span>
						<ChevronDown
							aria-hidden
							size={13}
							strokeWidth={2}
							className={cn(
								"transition-transform motion-reduce:transition-none",
								!resolvedUnfolded && "-rotate-90",
							)}
						/>
					</button>
					{resolvedUnfolded && (
						<ul className="m-0 flex list-none flex-col gap-px p-0">
							{(searching ? resolved : resolved.slice(0, resolvedShown)).map((row) => (
								<li key={row.conversation.id}>
									<DoneEntry
										row={row}
										owner={owner}
										userId={userId}
										selected={row.conversation.id === selectedConversationId}
									/>
								</li>
							))}
							{!searching && resolved.length > resolvedShown && (
								<li>
									<button
										type="button"
										onClick={() => setResolvedShown(resolvedShown + RESOLVED_SHOWN.more)}
										className={cn(sidebarRow({ radius: "md" }), "w-full text-subtle-foreground")}
									>
										<ChevronDown aria-hidden size={14} strokeWidth={2} className="shrink-0" />
										Show {Math.min(RESOLVED_SHOWN.more, resolved.length - resolvedShown)} more
									</button>
								</li>
							)}
						</ul>
					)}
				</section>
			)}
		</div>
	);
}

/**
 * The threads of a bot or project, those not archived, done ones among them,
 * and the latest runs of its automations, with whether an automation's latest
 * run failed, or a bot's paused itself after failing, until a run goes well
 * again. A project's automations list does not say whether one paused itself,
 * so a project's are flagged by their runs alone.
 */
export function useOwnerWork(owner: ResourceOwner): {
	threads: readonly ListedThread[];
	threadsFailed: boolean;
	runs: Run[];
	latestRunFailed: boolean;
} {
	const botList = useBotThreads("bot" in owner ? owner.bot.id : undefined);
	const projectList = useProjectThreads("project" in owner ? owner.project.slug : undefined);
	const projectAutomations = useAutomations("project" in owner ? owner.project.id : undefined).data;
	const automations =
		"bot" in owner
			? (botList.data?.automations ?? []).map(({ automation }) => automation)
			: (projectAutomations ?? []).map(({ id }) => ({ id, pausedAfterFailures: false }));
	const runs = useProjectRuns(
		resourceProjectId(owner),
		automations.map((automation) => automation.id),
	);
	const latestRunFailed = automations.some(
		(automation) =>
			runs.find((run) => run.automationId === automation.id)?.state === "failed" ||
			automation.pausedAfterFailures,
	);
	const threadList = "bot" in owner ? botList : projectList;
	return {
		threads: ("bot" in owner ? botList.data?.threads : projectList.data?.chats) ?? [],
		threadsFailed: threadList.isError,
		runs,
		latestRunFailed,
	};
}

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
 * One of the open threads: when it last moved, its whole title and how many
 * messages it holds, and under it the faces of who is talking in it when
 * there is more than one. Pointed at, Done takes the time's place.
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
	// More than one person in it, whose faces then get a line of their own.
	const together = people.length > 1;
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
				<span className="flex min-w-0 items-center justify-end text-subtle-foreground text-xs">
					{/* Its place goes to Done while the row is pointed at. */}
					<time
						dateTime={movedAt.toISOString()}
						className="shrink-0 tabular-nums group-focus-within/thread:invisible group-hover/thread:invisible"
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</span>
				{/* With one person in it, its message count sits beside the title; with more, under it beside their faces. */}
				<span className="flex min-w-0 items-start gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 break-words text-sm leading-snug",
							unread ? "font-semibold text-foreground" : "text-soft-foreground",
						)}
					>
						{conversation.title}
					</span>
					{!together && <MessageCount count={row.messageCount} className="h-5" />}
				</span>
				{/* Who is talking, by their names, for whoever can't see the faces. */}
				<span className="sr-only">{talking}</span>
				{together && (
					<span className="flex min-w-0 items-center gap-1.5 text-subtle-foreground text-xs">
						<span aria-hidden className="flex shrink-0">
							<ParticipantFaces participants={people} shown={4} size={16} surface="var(--rail)" />
						</span>
						<span className="flex-1" />
						<MessageCount count={row.messageCount} />
					</span>
				)}
			</OwnerLink>
			<button
				type="button"
				disabled={setDone.isPending}
				onClick={() => setDone.mutate(true)}
				aria-label={`Done: ${conversation.title}`}
				className="focus-ring absolute top-1 right-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-subtle-foreground text-xs opacity-0 transition-opacity hover:bg-hover hover:text-foreground group-focus-within/thread:opacity-100 group-hover/thread:opacity-100"
			>
				Done
				<Check aria-hidden size={12} strokeWidth={2.25} />
			</button>
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
						"focus-ring flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
						selected
							? "bg-row-selected text-foreground"
							: "text-subtle-foreground group-hover/thread:bg-row-hover group-hover/thread:text-soft-foreground",
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
						className="shrink-0 text-xs tabular-nums group-focus-within/thread:invisible group-hover/thread:invisible"
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</OwnerLink>
			</Tooltip>
			<IconButton
				label={`Reopen: ${row.conversation.title}`}
				disabled={setDone.isPending}
				onClick={() => setDone.mutate(false)}
				className="absolute top-1 right-1 rounded-md text-subtle-foreground opacity-0 transition-opacity group-focus-within/thread:opacity-100 group-hover/thread:opacity-100"
			>
				<RotateCcw aria-hidden strokeWidth={2} />
			</IconButton>
		</div>
	);
}

/** How a run stands, as its row says it. */
const RUN_STATE: Record<Run["state"], { label: string; className: string }> = {
	queued: { label: "Queued", className: "text-subtle-foreground" },
	running: { label: "Running", className: "text-success-text" },
	completed: { label: "Done", className: "text-subtle-foreground" },
	failed: { label: "Failed", className: "text-destructive-text" },
	cancelled: { label: "Stopped", className: "text-subtle-foreground" },
};

/**
 * One run of the automations: how it went and when, and its automation's
 * name. It opens as a page of its automation's.
 */
function RunEntry({ run, owner, selected }: { run: Run; owner: ResourceOwner; selected: boolean }) {
	const hideSidebar = useHideSidebar();
	const state = RUN_STATE[run.state];
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
				<CalendarClock aria-hidden size={12} strokeWidth={1.75} className="shrink-0" />
				<span className={state.className}>{state.label}</span>
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
function matches(row: ListedThread, search: string): boolean {
	return (
		includesFolded(row.conversation.title, search) ||
		row.participants.some((participant) => includesFolded(participant.name, search))
	);
}

function includesFolded(text: string, search: string): boolean {
	return text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}

/** How many messages a thread holds, as a quiet count with a speech mark. */
function MessageCount({ count, className }: { count: number; className?: string }) {
	return (
		<span
			className={cn(
				"flex shrink-0 items-center gap-1 text-subtle-foreground text-xs tabular-nums",
				className,
			)}
		>
			<MessageSquare aria-hidden size={12} strokeWidth={1.75} />
			<span aria-hidden>{count}</span>
			<span className="sr-only">{countOf(count, "message", "messages")}</span>
		</span>
	);
}

import { useRender } from "@base-ui/react/use-render";
import type { Bot, ChatListItem, ProviderPresetId, Run } from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { Link, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import {
	CalendarClock,
	Check,
	ChevronDown,
	ChevronLeft,
	CircleAlert,
	Cpu,
	Folder,
	ListFilter,
	MessageSquare,
	RotateCcw,
	Search,
	Settings2,
	SquarePen,
	Wrench,
	Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useBotRuns } from "@/lib/automations.ts";
import { useModelName, useModels } from "@/lib/bots.ts";
import { useBotTasks, useSetDone } from "@/lib/chats.ts";
import {
	automationFeedLink,
	automationsLink,
	botLink,
	botSettingsLink,
	botSettingsPageLink,
	conversationLink,
	filesLink,
} from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { modelLogoOf } from "@/lib/model-logo.ts";
import { countOf } from "@/lib/name-list.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { ParticipantFaces } from "@/screens/ParticipantFaces.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** How many of a bot's tasks and runs show before View all. */
const ENTRIES_SHOWN = 8;

/** How many done tasks show at first, and how many more each Show more adds. */
const RESOLVED_SHOWN = { first: 10, more: 25 };

/** Which of a bot's work its sidebar lists: all of it, its tasks, or its automations' runs. */
type Showing = "all" | "tasks" | "runs";

const SHOWING_LABELS: Record<Showing, string> = {
	all: "All",
	tasks: "Tasks",
	runs: "Automation runs",
};

/** One of a bot's tasks, or one run of its automations, by when it last moved. */
type Entry =
	| { kind: "task"; row: ChatListItem; at: number }
	| { kind: "run"; run: Run; at: number };

/** The model a bot answers on, by name and its maker's logo, as its rows show it. */
interface ModelMark {
	name: string | null;
	logo: ProviderPresetId | null;
}

/**
 * The sidebar on a bot's pages, in place of the channels and bots: the way
 * back to them, the bot's own pages, a search and a filter over its work, the
 * tasks that need the viewer, then its open tasks and its automations' runs
 * together, newest first, and its done tasks folded away under them.
 */
export function BotSidebar({
	bot,
	userId,
	selectedConversationId,
	page,
}: {
	bot: Bot;
	userId: string | undefined;
	/** The task open, marked in the list. */
	selectedConversationId: string | undefined;
	/** The bot's files or automations, while one of them is the page open. */
	page: "files" | "automations" | undefined;
}) {
	const list = useBotTasks(bot.id).data;
	const models = useModels().data;
	const modelName = useModelName(bot.model);
	const served = models?.models.find((model) => model.modelId === bot.model);
	const model: ModelMark = {
		name: modelName,
		logo: modelLogoOf(bot.model, served?.providerPreset ?? null),
	};
	// What stops the bot answering that its settings set right: no model, or one since switched off.
	const settingsProblem =
		bot.model === null
			? "No model chosen"
			: models && served === undefined
				? "This model is no longer switched on for the workspace"
				: undefined;
	const [allShown, setAllShown] = useState(false);
	const [search, setSearch] = useState("");
	const [showing, setShowing] = useState<Showing>("all");
	const searching = search.trim() !== "";
	// A run open as a page of its automation's, marked in the list.
	const openRun = useSearch({ strict: false, select: (params) => params.itemPage });
	const tasks = list?.tasks ?? [];
	const automations = list?.automations ?? [];
	const runs = useBotRuns(
		bot.id,
		automations.map(({ automation }) => automation.id),
	);
	// An automation whose latest run failed, or which paused itself after failing, until a run goes well again.
	const latestRunFailed = automations.some(
		({ automation }) =>
			runs.find((run) => run.automationId === automation.id)?.state === "failed" ||
			automation.pausedAfterFailures,
	);
	const automationsProblem = latestRunFailed ? "An automation's last run failed" : undefined;
	const needsYou = tasks.filter(
		(row) =>
			row.conversation.doneAt === null &&
			(row.needsApproval || row.mentionsYou) &&
			matches(row, search),
	);
	const entries: Entry[] = [
		...(showing === "runs"
			? []
			: tasks
					.filter(
						(row) =>
							row.conversation.doneAt === null && !needsYou.includes(row) && matches(row, search),
					)
					.map((row): Entry => ({ kind: "task", row, at: lastMovedAt(row) }))),
		...(showing === "tasks"
			? []
			: runs
					.filter((run) => includesFolded(run.automationName, search))
					.map((run): Entry => ({ kind: "run", run, at: Date.parse(run.acceptedAt) }))),
	].toSorted((a, b) => b.at - a.at);
	// A search shows everything it finds.
	const shown = allShown || searching ? entries : entries.slice(0, ENTRIES_SHOWN);
	// Done tasks keep out of the way, under their own fold, newest first.
	const [resolvedOpen, setResolvedOpen] = useState(true);
	const [resolvedShown, setResolvedShown] = useState(RESOLVED_SHOWN.first);
	const resolved =
		showing === "runs"
			? []
			: tasks
					.filter((row) => row.conversation.doneAt !== null && matches(row, search))
					.toSorted((a, b) => lastMovedAt(b) - lastMovedAt(a));
	const resolvedUnfolded = resolvedOpen || searching;
	return (
		<>
			<div className="flex flex-col gap-0.5 px-3 pt-1 pb-2">
				<nav aria-label={`${bot.name}'s pages`} className="flex flex-col gap-px pb-1">
					{/* Back to the channels and every bot; the page's breadcrumb names this one. */}
					<PageRow
						link={<Link to="/$workspace" from="/$workspace" />}
						selected={false}
						icon={<ChevronLeft aria-hidden size={15} strokeWidth={1.75} />}
						label="All bots"
					/>
					<PageRow
						link={<Link {...filesLink({ bot })} />}
						selected={page === "files"}
						icon={<Folder aria-hidden size={15} strokeWidth={1.75} />}
						label="Files"
					/>
					<PageRow
						link={<Link {...automationsLink(bot)} />}
						selected={page === "automations"}
						problem={automationsProblem}
						icon={<Zap aria-hidden size={15} strokeWidth={1.75} />}
						label="Automations"
					/>
					{bot.permissions.update && (
						<>
							<PageRow
								link={<Link {...botSettingsPageLink(bot, "connections")} />}
								selected={false}
								icon={<Wrench aria-hidden size={15} strokeWidth={1.75} />}
								label="Tools"
							/>
							<PageRow
								link={<Link {...botSettingsLink(bot)} />}
								selected={false}
								problem={settingsProblem}
								icon={<Settings2 aria-hidden size={15} strokeWidth={1.75} />}
								label="Settings"
							/>
						</>
					)}
				</nav>
				<div className="flex items-center gap-1 pt-1">
					<label className="focus-ring-within flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-chip px-2 text-subtle-foreground">
						<Search aria-hidden size={14} strokeWidth={2} className="shrink-0" />
						<input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") setSearch("");
							}}
							placeholder="Search tasks"
							aria-label={`Search ${bot.name}'s tasks`}
							className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
						/>
					</label>
					<ShowingMenu showing={showing} onChange={setShowing} />
					<IconButton
						label="New task"
						render={<Link {...botLink(bot)} />}
						className="size-8 shrink-0 rounded-md text-subtle-foreground hover:bg-row-hover hover:text-foreground [&_svg]:size-3.75"
					>
						<SquarePen aria-hidden />
					</IconButton>
				</div>
			</div>
			<div className="scrollbar-on-hover flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pt-2 pb-3">
				{needsYou.length > 0 && showing !== "runs" && (
					<section className="flex flex-col gap-1">
						<h3 className="m-0 px-2 pb-1 font-normal text-subtle-foreground text-xs">Needs you</h3>
						<ul className="m-0 flex list-none flex-col gap-px p-0">
							{needsYou.map((row) => (
								<li key={row.conversation.id}>
									<NeedsYouRow
										row={row}
										bot={bot}
										selected={row.conversation.id === selectedConversationId}
									/>
								</li>
							))}
						</ul>
					</section>
				)}
				<ul aria-label={`${bot.name}'s work`} className="m-0 flex list-none flex-col gap-px p-0">
					{shown.map((entry) =>
						entry.kind === "task" ? (
							<li key={entry.row.conversation.id}>
								<TaskEntry
									row={entry.row}
									bot={bot}
									userId={userId}
									model={model}
									selected={entry.row.conversation.id === selectedConversationId}
								/>
							</li>
						) : (
							<li key={entry.run.id}>
								<RunEntry
									run={entry.run}
									bot={bot}
									model={model}
									selected={entry.run.conversationId === openRun}
								/>
							</li>
						),
					)}
					{entries.length === 0 && resolved.length === 0 && needsYou.length === 0 && (
						<li className="px-2 py-1 text-subtle-foreground text-xs">
							{searching
								? "Nothing matches."
								: showing === "runs"
									? "No automation runs yet."
									: "No tasks yet."}
						</li>
					)}
					{!searching && entries.length > ENTRIES_SHOWN && (
						<li>
							<button
								type="button"
								aria-expanded={allShown}
								onClick={() => setAllShown(!allShown)}
								className="focus-ring mt-1 rounded-sm px-2 text-subtle-foreground text-xs transition-colors hover:text-foreground"
							>
								{allShown ? "Show fewer" : "View all"}
							</button>
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
						{/* A search opens it, and shows all it finds there. */}
						{resolvedUnfolded && (
							<ul className="m-0 flex list-none flex-col gap-px p-0">
								{(searching ? resolved : resolved.slice(0, resolvedShown)).map((row) => (
									<li key={row.conversation.id}>
										<DoneEntry
											row={row}
											bot={bot}
											userId={userId}
											model={model}
											selected={row.conversation.id === selectedConversationId}
										/>
									</li>
								))}
								{!searching && resolved.length > resolvedShown && (
									<li>
										<button
											type="button"
											onClick={() => setResolvedShown(resolvedShown + RESOLVED_SHOWN.more)}
											className="focus-ring flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-subtle-foreground text-sm transition-colors hover:bg-row-hover hover:text-foreground"
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
		</>
	);
}

/** One of the bot's own pages: its icon and name, and an alert for something wrong that the page sets right. */
function PageRow({
	link,
	selected,
	icon,
	label,
	problem,
}: {
	/** The `Link` the row is. */
	link: useRender.RenderProp;
	selected: boolean;
	icon: ReactNode;
	label: string;
	problem?: string;
}) {
	return useRender({
		render: link,
		props: {
			"aria-current": selected ? "page" : undefined,
			"aria-description": problem,
			className: cn(
				"focus-ring flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
				selected
					? "bg-row-selected text-foreground"
					: "text-muted-foreground hover:bg-row-hover hover:text-foreground",
			),
			children: (
				<>
					{icon}
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{problem && (
						<Tooltip label={problem} side="right">
							<CircleAlert
								aria-hidden
								size={14}
								strokeWidth={2}
								className="shrink-0 text-destructive-text"
							/>
						</Tooltip>
					)}
				</>
			),
		},
	});
}

/** A task waiting on the viewer, on one line: a dot, then its title. */
function NeedsYouRow({ row, bot, selected }: { row: ChatListItem; bot: Bot; selected: boolean }) {
	const hideSidebar = useHideSidebar();
	return (
		<Link
			{...conversationLink({ bot, conversationId: row.conversation.id })}
			aria-current={selected ? "page" : undefined}
			onDoubleClick={hideSidebar}
			className={cn(
				"focus-ring flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
				selected
					? "bg-row-selected text-foreground"
					: "text-muted-foreground hover:bg-row-hover hover:text-foreground",
			)}
		>
			<span className="grid w-3 shrink-0 place-items-center">
				<span aria-hidden className="size-1.5 rounded-full bg-warning" />
			</span>
			<span className="min-w-0 flex-1 truncate">{row.conversation.title}</span>
			<span className="sr-only">
				{row.needsApproval ? ", needs your approval" : ", mentions you"}
			</span>
		</Link>
	);
}

/** The model a row's task is answered on, by its maker's logo, named for a screen reader. */
function ModelMarkIcon({ model, className }: { model: ModelMark; className?: string }) {
	if (!model.name) return null;
	return (
		<span title={model.name} className={cn("flex shrink-0 items-center", className)}>
			{model.logo ? (
				<ProviderLogo preset={model.logo} className="size-3.5" />
			) : (
				<Cpu aria-hidden size={13} strokeWidth={1.75} />
			)}
			<span className="sr-only">{model.name}</span>
		</span>
	);
}

/**
 * One of the bot's open tasks: how many messages it holds and when it last
 * moved, its whole title, and under it the faces of who is talking in it and
 * the model answering in it. Pointed at, Done takes the time's place.
 */
function TaskEntry({
	row,
	bot,
	userId,
	model,
	selected,
}: {
	row: ChatListItem;
	bot: Bot;
	userId: string | undefined;
	model: ModelMark;
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
		<div className="group/task relative">
			<Link
				{...conversationLink({ bot, conversationId: conversation.id })}
				aria-current={selected ? "page" : undefined}
				onDoubleClick={hideSidebar}
				className={cn(
					"focus-ring flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 transition-colors",
					selected ? "bg-row-selected" : "group-hover/task:bg-row-hover",
				)}
			>
				<span className="flex min-w-0 items-center gap-1.5 text-subtle-foreground text-xs">
					<MessageSquare aria-hidden size={12} strokeWidth={1.75} className="shrink-0" />
					<span className="tabular-nums">
						{row.messageCount}
						<span className="sr-only">{row.messageCount === 1 ? " message" : " messages"}</span>
					</span>
					<span className="flex-1" />
					{/* Its place goes to Done while the row is pointed at. */}
					<time
						dateTime={movedAt.toISOString()}
						className="shrink-0 tabular-nums group-focus-within/task:invisible group-hover/task:invisible"
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</span>
				{/* With one person in it, its model sits beside the title; with more, under it beside their faces. */}
				<span className="flex min-w-0 items-start gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 break-words text-sm leading-snug",
							unread ? "font-semibold text-foreground" : "text-soft-foreground",
						)}
					>
						{conversation.title}
					</span>
					{!together && <ModelMarkIcon model={model} className="h-5 text-subtle-foreground" />}
				</span>
				{/* Who is talking, by their names, for whoever can't see the faces. */}
				<span className="sr-only">{talking}</span>
				{together && (
					<span className="flex min-w-0 items-center gap-1.5 text-subtle-foreground text-xs">
						<span aria-hidden className="flex shrink-0">
							<ParticipantFaces participants={people} shown={4} size={16} surface="var(--rail)" />
						</span>
						<span className="flex-1" />
						<ModelMarkIcon model={model} />
					</span>
				)}
			</Link>
			<button
				type="button"
				disabled={setDone.isPending}
				onClick={() => setDone.mutate(true)}
				aria-label={`Done: ${conversation.title}`}
				className="focus-ring absolute top-1 right-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-subtle-foreground text-xs opacity-0 transition-opacity hover:bg-hover hover:text-foreground group-focus-within/task:opacity-100 group-hover/task:opacity-100"
			>
				Done
				<Check aria-hidden size={12} strokeWidth={2.25} />
			</button>
		</div>
	);
}

/**
 * A done task, kept quiet: who is in it, its title and when it last moved, on
 * one line, the rest said when it is pointed at. Pointed at, Reopen takes
 * the time's place.
 */
function DoneEntry({
	row,
	bot,
	userId,
	model,
	selected,
}: {
	row: ChatListItem;
	bot: Bot;
	userId: string | undefined;
	model: ModelMark;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	const setDone = useSetDone(row.conversation.id);
	const people = row.participants.filter((participant) => participant.kind === "person");
	const talking = people.map((person) => (person.id === userId ? "You" : person.name)).join(", ");
	const movedAt = new Date(lastMovedAt(row));
	const about = [talking, countOf(row.messageCount, "message", "messages"), model.name]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="group/task relative">
			<Tooltip label={about} side="right" align="start">
				<Link
					{...conversationLink({ bot, conversationId: row.conversation.id })}
					aria-current={selected ? "page" : undefined}
					onDoubleClick={hideSidebar}
					className={cn(
						"focus-ring flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-sm transition-colors",
						selected
							? "bg-row-selected text-foreground"
							: "text-subtle-foreground group-hover/task:bg-row-hover group-hover/task:text-soft-foreground",
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
						className="shrink-0 text-xs tabular-nums group-focus-within/task:invisible group-hover/task:invisible"
					>
						{formatListTime(movedAt, new Date())}
					</time>
				</Link>
			</Tooltip>
			<IconButton
				label={`Reopen: ${row.conversation.title}`}
				disabled={setDone.isPending}
				onClick={() => setDone.mutate(false)}
				className="absolute top-1 right-1 size-6 rounded-md text-subtle-foreground opacity-0 transition-opacity hover:bg-hover hover:text-foreground group-focus-within/task:opacity-100 group-hover/task:opacity-100 [&_svg]:size-3.5"
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
 * One run of the bot's automations: how it went and when, its automation's
 * name, and the model it ran on. It opens as a page of its automation's.
 */
function RunEntry({
	run,
	bot,
	model,
	selected,
}: {
	run: Run;
	bot: Bot;
	model: ModelMark;
	selected: boolean;
}) {
	const hideSidebar = useHideSidebar();
	const state = RUN_STATE[run.state];
	const at = run.finishedAt ?? run.startedAt ?? run.acceptedAt;
	return (
		<Link
			{...automationFeedLink(bot, run.automationId, { itemPage: run.conversationId })}
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
			<span className="flex min-w-0 items-center text-subtle-foreground text-xs">
				<span className="flex-1">Automation run</span>
				<ModelMarkIcon model={model} />
			</span>
		</Link>
	);
}

/** Lists all of a bot's work, its tasks alone, or its automations' runs alone. */
function ShowingMenu({
	showing,
	onChange,
}: {
	showing: Showing;
	onChange: (showing: Showing) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<IconButton
						label={`Showing ${SHOWING_LABELS[showing].toLocaleLowerCase()}`}
						className={cn(
							"size-8 shrink-0 rounded-md hover:bg-row-hover hover:text-foreground data-popup-open:bg-row-hover [&_svg]:size-3.75",
							showing === "all" ? "text-subtle-foreground" : "bg-row-selected text-foreground",
						)}
					>
						<ListFilter aria-hidden />
					</IconButton>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuRadioGroup
					value={showing}
					onValueChange={(value) => onChange(value as Showing)}
				>
					{(Object.keys(SHOWING_LABELS) as Showing[]).map((option) => (
						<DropdownMenuRadioItem key={option} value={option}>
							{SHOWING_LABELS[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Whether a task's title, or the name of somebody in it, has `search` in it, whatever its case. */
function matches(row: ChatListItem, search: string): boolean {
	return (
		includesFolded(row.conversation.title, search) ||
		row.participants.some((participant) => includesFolded(participant.name, search))
	);
}

function includesFolded(text: string, search: string): boolean {
	return text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}

/** When a task last had something in it: its newest message, else when it was started. */
function lastMovedAt(row: ChatListItem): number {
	return Date.parse(row.lastMessage?.at ?? row.conversation.createdAt);
}

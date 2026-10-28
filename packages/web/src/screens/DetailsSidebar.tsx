import type {
	Agent,
	FilePart,
	Pod,
	SessionUser,
	ThreadParticipant,
	ThreadSummary,
} from "@sugabots/contracts";
import { connectionMarkFor } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronDown, FileText, Monitor, SquarePen } from "lucide-react";
import { useState } from "react";
import { useModelName } from "@/lib/agents.ts";
import { useBuiltInAgents } from "@/lib/built-in-agents.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { agentSettingsLink, newThreadLink, routineThreadLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRoutineActions, useRoutines } from "@/lib/routines.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useThreadActivity } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { ScribeNotSetUp } from "./BuiltInAgentSetup.tsx";
import {
	ChatSidebar,
	Expandable,
	SECTION_LIST_CLASS_NAME,
	ShowMore,
	SidebarSection,
} from "./ChatSidebar.tsx";
import { ContextMeter, usedPercentOf } from "./ContextMeter.tsx";

/** How many rows a list shows before Show more. */
const FILES_SHOWN = 3;
const ROUTINES_SHOWN = 2;
/** A summary longer than this is folded to four lines until asked for the rest. */
const SUMMARY_FOLDED_OVER = 240;

/**
 * A bot beside its chat: its face, name and model, and the way to its
 * settings, then what the chat is about, how much of the bot's short-term
 * memory it fills, the routines it runs, the apps it can reach, who is in the
 * chat and the files shared there. A phone gives it a page, headed by the bot
 * over a new thread with it, its computer and its settings, with its memory
 * last.
 */
export function DetailsSidebar({
	agent,
	pod,
	threadId,
	user,
	contents,
	onOpenDesktop,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	threadId: string;
	user: SessionUser;
	/** Who is in the thread, and the files shared in it. */
	contents: ThreadContents;
	onOpenDesktop: () => void;
	onClose: () => void;
}) {
	const backToChat = useBackToHere("Chat");
	const activity = useThreadActivity(threadId).data;
	const scribe = useBuiltInAgents().data?.find(({ key }) => key === "summarise");
	const modelName = useModelName(agent.model);
	return (
		<ChatSidebar label="Details" onClose={onClose} headerless className="xl:w-[300px]">
			<div className={DETAILS_PAGE_CLASS_NAME}>
				<div className="flex items-center gap-3 px-5 pt-5 pb-4 max-md:flex-col max-md:gap-2.5 max-md:p-0 max-md:pb-1">
					<AgentAvatar
						color={agent.color}
						face={agent.face}
						shape={agent.shape}
						size={36}
						className="shrink-0 max-md:hidden"
					/>
					<AgentAvatar
						color={agent.color}
						face={agent.face}
						shape={agent.shape}
						size={84}
						className="md:hidden"
					/>
					<div className="flex min-w-0 flex-1 flex-col leading-snug max-md:max-w-full max-md:items-center max-md:gap-0.5">
						<h3 className="m-0 max-w-full truncate font-semibold text-[14px] text-foreground max-md:text-[20px]">
							{agent.name}
						</h3>
						<p className="m-0 truncate text-subtle-foreground text-xs max-md:text-[13px] max-md:text-muted-foreground">
							{modelName ?? "No model chosen"}
						</p>
					</div>
					<IconButton
						label="Bot settings"
						variant="bar"
						render={<Link {...agentSettingsLink({ pod, agent })} state={backToChat} />}
						className="border border-border-strong max-md:hidden"
					>
						<SettingsIcon size={15} />
					</IconButton>
				</div>
				<div className="grid grid-cols-3 gap-2 md:hidden">
					<Link {...newThreadLink(pod, agent)} className={ACTION_TILE_CLASS_NAME}>
						<SquarePen aria-hidden size={20} strokeWidth={1.75} />
						New thread
					</Link>
					<button type="button" onClick={onOpenDesktop} className={ACTION_TILE_CLASS_NAME}>
						<Monitor aria-hidden size={20} strokeWidth={1.75} />
						Computer
					</button>
					<Link
						{...agentSettingsLink({ pod, agent })}
						state={backToChat}
						className={ACTION_TILE_CLASS_NAME}
					>
						<SettingsIcon aria-hidden size={20} />
						Settings
					</Link>
				</div>
				<Summary summary={activity?.summary} scribeHasModel={scribe && scribe.model !== null} />
				{activity?.context && (
					<SidebarSection
						title="Memory"
						bare
						className="max-md:order-last"
						end={
							<span className="font-mono text-muted-foreground text-xs">
								{usedPercentOf(activity.context)}%
							</span>
						}
					>
						<ContextMeter context={activity.context} />
					</SidebarSection>
				)}
				<Routines pod={pod} agent={agent} />
				<Tools pod={pod} agent={agent} />
				<InThisThread participants={contents.participants} user={user} />
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
			</div>
		</ChatSidebar>
	);
}

/** Details' scrolling content: a column of sections, which a phone spaces apart under its Back. */
const DETAILS_PAGE_CLASS_NAME =
	"flex min-h-0 flex-1 flex-col overflow-y-auto pb-6 max-md:gap-[22px] max-md:px-4 max-md:pt-16 max-md:pb-8";

/** One of the ways from the head of a phone's Details: an icon over its name, on a tile. */
const ACTION_TILE_CLASS_NAME =
	"focus-ring flex h-16 flex-col items-center justify-center gap-1.5 rounded-[14px] bg-chip text-[13px] text-foreground";

/** Who is in a thread, and the files shared in it, each opening where it is served. */
export interface ThreadContents {
	participants: readonly ThreadParticipant[];
	/** The files in the messages loaded so far, oldest first: older pages add theirs as they load. */
	files: readonly FilePart[];
	fileUrlOf: (fileId: string) => string;
}

/** A thread between people, beside it: who is in it, and the files shared there. */
export function PeopleDetails({
	user,
	contents,
	onClose,
}: {
	user: SessionUser;
	contents: ThreadContents;
	onClose: () => void;
}) {
	return (
		<ChatSidebar label="Details" onClose={onClose} headerless className="xl:w-[300px]">
			<div className={cn(DETAILS_PAGE_CLASS_NAME, "xl:[&>section:first-child]:border-t-0")}>
				<InThisThread participants={contents.participants} user={user} />
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
			</div>
		</ChatSidebar>
	);
}

/** How many faces the folded In this thread shows before counting the rest. */
const FACES_SHOWN = 4;

/**
 * Everyone in the thread: their faces and how many, which opens the list of
 * them, each bot, and each person, the viewer as You. A phone lists them all.
 */
function InThisThread({
	participants,
	user,
}: {
	participants: readonly ThreadParticipant[];
	user: SessionUser;
}) {
	const [open, setOpen] = useState(false);
	if (participants.length === 0) return null;
	const hidden = participants.length - FACES_SHOWN;
	return (
		<SidebarSection
			title="In this thread"
			end={
				<button
					type="button"
					aria-expanded={open}
					aria-label={`${participants.length} in this thread`}
					onClick={() => setOpen(!open)}
					className="focus-ring -mr-1 flex items-center gap-2 rounded-md py-0.5 pr-1 pl-2 hover:bg-row-hover max-md:hidden"
				>
					<span aria-hidden className="flex pl-1.5">
						{participants.slice(0, FACES_SHOWN).map((participant) => (
							<span key={participant.id} className="-ml-1.5 rounded-full ring-2 ring-background">
								<Face participant={participant} size={20} />
							</span>
						))}
						{hidden > 0 && (
							<span className="-ml-1.5 grid size-5 place-items-center rounded-full bg-chip font-semibold text-[9px] text-muted-foreground ring-2 ring-background">
								+{hidden}
							</span>
						)}
					</span>
					<span aria-hidden className="text-muted-foreground text-xs">
						{participants.length}
					</span>
					<ChevronDown
						aria-hidden
						size={12}
						strokeWidth={2}
						className={cn("text-subtle-foreground transition-transform", open && "rotate-180")}
					/>
				</button>
			}
		>
			<ul className={cn(SECTION_LIST_CLASS_NAME, !open && "md:hidden")}>
				{participants.map((participant) => (
					<ParticipantRow key={participant.id} participant={participant} user={user} />
				))}
			</ul>
		</SidebarSection>
	);
}

function Face({ participant, size }: { participant: ThreadParticipant; size: number }) {
	return participant.kind === "agent" ? (
		<AgentAvatar
			color={participant.color}
			face={participant.face}
			shape={participant.shape}
			size={size}
		/>
	) : (
		<PersonAvatar person={participant} size={size} />
	);
}

/** The files shared in the thread, newest first, each opening as it is served. */
function SharedFiles({
	files,
	fileUrlOf,
}: {
	files: readonly FilePart[];
	fileUrlOf: (fileId: string) => string;
}) {
	if (files.length === 0) return null;
	return (
		<SidebarSection title="Files">
			<Expandable items={[...files].reverse()} shown={FILES_SHOWN}>
				{(file) => (
					<li key={file.id}>
						<a
							href={fileUrlOf(file.id)}
							target="_blank"
							rel="noreferrer"
							className={ROW_LINK_CLASS_NAME}
						>
							<span className="grid size-[22px] shrink-0 place-items-center rounded-[6px] border border-border-strong text-muted-foreground">
								<FileText aria-hidden size={12} strokeWidth={2} />
							</span>
							<span className={ROW_NAME_CLASS_NAME}>{file.name}</span>
						</a>
					</li>
				)}
			</Expandable>
		</SidebarSection>
	);
}

function Summary({
	summary,
	scribeHasModel,
}: {
	summary: ThreadSummary | null | undefined;
	/** `undefined` while the built-in agents load, so the unconfigured state is not flashed. */
	scribeHasModel: boolean | undefined;
}) {
	const [open, setOpen] = useState(false);
	if (scribeHasModel === false) {
		return (
			<SidebarSection title="Summary">
				<ScribeNotSetUp />
			</SidebarSection>
		);
	}
	const text = summary?.content;
	const folds = text !== undefined && text.length > SUMMARY_FOLDED_OVER;
	return (
		<SidebarSection title="Summary">
			<p
				className={cn(
					"m-0 text-[13px] leading-[1.55] max-md:my-1.5 max-md:text-[15px]",
					text ? "text-soft-foreground" : "text-muted-foreground",
					folds && !open && "line-clamp-3",
				)}
			>
				{text ?? "A summary will appear after the first reply."}
			</p>
			{folds && <ShowMore open={open} onToggle={() => setOpen(!open)} />}
		</SidebarSection>
	);
}

function ParticipantRow({
	participant,
	user,
}: {
	participant: ThreadParticipant;
	user: SessionUser;
}) {
	return (
		<li className="flex h-[34px] items-center gap-2.5 max-md:h-[52px] max-md:gap-3">
			<span aria-hidden className="contents">
				<Face participant={participant} size={22} />
			</span>
			<span className={ROW_NAME_CLASS_NAME}>{participant.name}</span>
			<span className="text-subtle-foreground text-xs max-md:text-[13px]">
				{participant.kind === "agent" ? "Bot" : participant.id === user.id ? "You" : "Member"}
			</span>
		</li>
	);
}

/**
 * The bot's routines, each opening its page with its runs, with a switch to
 * pause or resume it for whoever may manage them.
 */
function Routines({ pod, agent }: { pod: Pod; agent: Agent }) {
	const routines = useRoutines(agent.id);
	const actions = useRoutineActions();
	const list = routines.data ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection title="Routines">
			<Expandable items={list} shown={ROUTINES_SHOWN}>
				{(routine) => (
					<li key={routine.id} className="flex items-center gap-3 py-1 max-md:py-2.5">
						<Link
							{...routineThreadLink(pod, routine.id)}
							className="focus-ring flex min-w-0 flex-1 flex-col rounded-sm leading-snug hover:[&>span:first-child]:underline"
						>
							<span className="truncate text-[13px] text-foreground max-md:text-[15px]">
								{routine.name}
							</span>
							{scheduleLabel(routine) && (
								<span className="truncate text-subtle-foreground text-xs">
									{scheduleLabel(routine)}
								</span>
							)}
						</Link>
						<Toggle
							label={`${routine.name} on`}
							checked={routine.state === "enabled"}
							disabled={
								!pod.permissions.manageRoutines ||
								(actions.update.isPending && actions.update.variables?.routineId === routine.id)
							}
							onChange={(on) =>
								actions.update.mutate({
									agentId: agent.id,
									routineId: routine.id,
									json: { state: on ? "enabled" : "paused" },
								})
							}
						/>
					</li>
				)}
			</Expandable>
		</SidebarSection>
	);
}

/** The apps the bot can reach, which are its pod's connections, with how many of their tools it may use, each opening the bot's settings. */
export function Tools({ pod, agent }: { pod: Pod; agent: Agent }) {
	const backToChat = useBackToHere("Chat");
	const connections = useConnections(pod.id);
	const list = connections.data?.filter((connection) => usableToolCount(connection) > 0) ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection title="Tools">
			<ul className={SECTION_LIST_CLASS_NAME}>
				{list.map((connection) => (
					<li key={connection.id}>
						<Link
							{...agentSettingsLink({ pod, agent })}
							state={backToChat}
							className={ROW_LINK_CLASS_NAME}
						>
							<ConnectionMark
								presetId={connectionMarkFor(connection)}
								name={connection.name}
								size="md"
							/>
							<span className={ROW_NAME_CLASS_NAME}>{connection.name}</span>
							<span className="shrink-0 text-subtle-foreground text-xs max-md:text-[13px]">
								{countOf(usableToolCount(connection), "tool", "tools")}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</SidebarSection>
	);
}

/** A row in a section that opens something, taller on a phone's card. */
const ROW_LINK_CLASS_NAME =
	"focus-ring -mx-1.5 flex h-8 items-center gap-2.5 rounded-md px-1.5 transition-colors hover:bg-row-hover max-md:h-[52px] max-md:gap-3";

/** What a row in a section is called, larger on a phone. */
const ROW_NAME_CLASS_NAME =
	"min-w-0 flex-1 truncate text-[13px] text-foreground max-md:text-[15px]";

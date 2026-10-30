import { useRender } from "@base-ui/react/use-render";
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
import { Archive, ChevronDown, FileText, Hash, Pencil, RefreshCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useModelName } from "@/lib/agents.ts";
import { useBuiltInAgents } from "@/lib/built-in-agents.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { agentSettingsLink, routinesLink, routineThreadLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
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
import { SystemAgentsNotSetUp } from "./BuiltInAgentSetup.tsx";
import { ChannelActions, type ChannelToChange } from "./ChatMenu.tsx";
import { ChatSidebar, Expandable, ShowMore, SidebarSection } from "./ChatSidebar.tsx";
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
 * chat and the files shared there.
 */
export function DetailsSidebar({
	agent,
	pod,
	threadId,
	user,
	contents,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	threadId: string;
	user: SessionUser;
	/** Who is in the thread, and the files shared in it. */
	contents: ThreadContents;
	onClose: () => void;
}) {
	const backToChat = useBackToHere("Chat");
	const activity = useThreadActivity(threadId).data;
	const scribe = useBuiltInAgents().data?.find(({ key }) => key === "summarise");
	const modelName = useModelName(agent.model);
	return (
		<ChatSidebar label="Details" onClose={onClose} headerless className="xl:w-[300px]">
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
				{/* On a phone, the bot large in the middle, its name under it, then what can be done with it. */}
				<div className="flex items-center gap-3 px-5 pt-5 pb-4 max-md:flex-col max-md:gap-2.5 max-md:px-4 max-md:pt-1 max-md:text-center">
					<AgentAvatar
						color={agent.color}
						face={agent.face}
						shape={agent.shape}
						size={36}
						className="shrink-0 max-md:size-[88px]"
					/>
					<div className="flex min-w-0 flex-1 flex-col leading-snug max-md:gap-0.5">
						<h3 className="m-0 truncate font-semibold text-[14px] text-foreground max-md:text-[22px]">
							{agent.name}
						</h3>
						<p className="m-0 truncate text-subtle-foreground text-xs max-md:text-[14px]">
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
					<div className="flex justify-center gap-7 pt-2 md:hidden">
						<RoundAction
							render={<Link {...agentSettingsLink({ pod, agent })} state={backToChat} />}
							icon={<SettingsIcon size={20} />}
							label="Settings"
						/>
						<RoundAction
							render={<Link {...routinesLink(pod, agent)} />}
							icon={<RefreshCcw size={20} strokeWidth={1.75} />}
							label="Routines"
						/>
					</div>
				</div>
				<Summary summary={activity?.summary} scribeHasModel={scribe && scribe.model !== null} />
				{activity?.context && (
					<SidebarSection
						title="Memory"
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

/** On a phone, one of what can be done with the bot under its name: a round button over its label. */
function RoundAction({
	render,
	icon,
	label,
}: {
	render: useRender.RenderProp;
	icon: ReactNode;
	label: string;
}) {
	return useRender({
		render,
		props: {
			className:
				"focus-ring group/action flex w-16 flex-col items-center gap-1.5 rounded-xl text-[13px] text-soft-foreground",
			children: (
				<>
					<span className="grid size-12 place-items-center rounded-full bg-chip text-foreground transition-colors group-active/action:bg-hover-strong">
						{icon}
					</span>
					{label}
				</>
			),
		},
	});
}

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
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto pb-6 xl:[&>section:first-child]:border-t-0">
				<InThisThread participants={contents.participants} user={user} />
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
			</div>
		</ChatSidebar>
	);
}

/**
 * One of a pod's channels, beside it: its name, and on a phone, renaming it
 * and archiving it for whoever may; then who is in it and the files shared
 * there.
 */
export function ChannelDetails({
	name,
	people,
	bots,
	channel,
	user,
	contents,
	onClose,
}: {
	name: string;
	/** How many people and bots are in the channel, as its intro counts them. */
	people: number;
	bots: number;
	/** The channel, for whoever may rename or archive it. */
	channel?: ChannelToChange;
	user: SessionUser;
	contents: ThreadContents;
	onClose: () => void;
}) {
	return (
		<ChatSidebar label="Details" onClose={onClose} headerless className="xl:w-[300px]">
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto pb-6">
				<div className="flex items-center gap-3 px-5 pt-5 pb-4 max-md:flex-col max-md:gap-2.5 max-md:px-4 max-md:pt-1 max-md:text-center">
					<span
						aria-hidden
						className="grid size-9 shrink-0 place-items-center rounded-[30%] bg-chip text-soft-foreground max-md:size-[88px]"
					>
						<Hash size={18} strokeWidth={2} className="max-md:size-9" />
					</span>
					<div className="flex min-w-0 flex-1 flex-col leading-snug max-md:gap-0.5">
						<h3 className="m-0 truncate font-semibold text-[14px] text-foreground max-md:text-[22px]">
							{name}
						</h3>
						<p className="m-0 truncate text-subtle-foreground text-xs max-md:text-[14px]">
							{[countOf(people, "person", "people"), countOf(bots, "bot", "bots")].join(", ")}
						</p>
					</div>
					{channel && (
						<ChannelActions {...channel}>
							{({ rename, archive }) => (
								<div className="flex justify-center gap-7 pt-2 md:hidden">
									<RoundAction
										render={<button type="button" onClick={rename} />}
										icon={<Pencil size={20} strokeWidth={1.75} />}
										label="Rename"
									/>
									{archive && (
										<RoundAction
											render={<button type="button" onClick={archive} />}
											icon={<Archive size={20} strokeWidth={1.75} />}
											label="Archive"
										/>
									)}
								</div>
							)}
						</ChannelActions>
					)}
				</div>
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
 * them, each bot, and each person, the viewer as You. A phone, with the
 * room, always lists them.
 */
function InThisThread({
	participants,
	user,
}: {
	participants: readonly ThreadParticipant[];
	user: SessionUser;
}) {
	const [opened, setOpened] = useState(false);
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const open = opened || phone;
	if (participants.length === 0) return null;
	const hidden = participants.length - FACES_SHOWN;
	return (
		<SidebarSection
			title="In this thread"
			end={
				!phone && (
					<button
						type="button"
						aria-expanded={open}
						aria-label={`${participants.length} in this thread`}
						onClick={() => setOpened(!opened)}
						className="focus-ring -mr-1 flex items-center gap-2 rounded-md py-0.5 pr-1 pl-2 hover:bg-row-hover"
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
				)
			}
		>
			{open && (
				<ul className="m-0 flex list-none flex-col p-0">
					{participants.map((participant) => (
						<ParticipantRow key={participant.id} participant={participant} user={user} />
					))}
				</ul>
			)}
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
							className="focus-ring -mx-1.5 flex h-8 items-center gap-2.5 rounded-md px-1.5 transition-colors hover:bg-row-hover max-md:h-11 max-md:gap-3 max-md:active:bg-row-selected"
						>
							<span className="grid size-[22px] shrink-0 place-items-center rounded-[6px] border border-border-strong text-muted-foreground">
								<FileText aria-hidden size={12} strokeWidth={2} />
							</span>
							<span className="min-w-0 flex-1 truncate text-[13px] text-foreground max-md:text-[15px]">
								{file.name}
							</span>
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
				<SystemAgentsNotSetUp />
			</SidebarSection>
		);
	}
	const text = summary?.content;
	const folds = text !== undefined && text.length > SUMMARY_FOLDED_OVER;
	return (
		<SidebarSection title="Summary">
			<p
				className={cn(
					"m-0 text-[13px] leading-[1.55]",
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
		<li className="flex h-[34px] items-center gap-2.5 max-md:h-11 max-md:gap-3">
			<span aria-hidden className="contents">
				<Face participant={participant} size={22} />
			</span>
			<span className="min-w-0 flex-1 truncate text-[13px] text-foreground max-md:text-[15px]">
				{participant.name}
			</span>
			<span className="text-subtle-foreground text-xs">
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
					<li key={routine.id} className="flex items-center gap-3 py-1 max-md:min-h-11">
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
			<ul className="m-0 flex list-none flex-col p-0">
				{list.map((connection) => (
					<li key={connection.id}>
						<Link
							{...agentSettingsLink({ pod, agent })}
							state={backToChat}
							className="focus-ring -mx-1.5 flex h-8 items-center gap-2.5 rounded-md px-1.5 transition-colors hover:bg-row-hover max-md:h-11 max-md:gap-3 max-md:active:bg-row-selected"
						>
							<ConnectionMark
								presetId={connectionMarkFor(connection)}
								name={connection.name}
								size="md"
							/>
							<span className="min-w-0 flex-1 truncate text-[13px] text-foreground max-md:text-[15px]">
								{connection.name}
							</span>
							<span className="shrink-0 text-subtle-foreground text-xs">
								{countOf(usableToolCount(connection), "tool", "tools")}
							</span>
						</Link>
					</li>
				))}
			</ul>
		</SidebarSection>
	);
}

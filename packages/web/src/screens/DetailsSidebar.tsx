import { useRender } from "@base-ui/react/use-render";
import type {
	Bot,
	Connection,
	ConversationContext,
	ConversationSummary,
	FilePart,
	Participant,
	Project,
	SessionUser,
} from "@sugabots/contracts";
import { connectionMarkFor } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Archive, FileText, Monitor, Pencil, RefreshCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAutomationActions, useAutomations } from "@/lib/automations.ts";
import { useModelName } from "@/lib/bots.ts";
import { useComputerGap } from "@/lib/computer-providers.ts";
import { usableToolCount, useConnectionActions, useConnections } from "@/lib/connections.ts";
import { useConversationActivity } from "@/lib/conversations.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { projectHeadcount } from "@/lib/project-headcount.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { automationStartsLabel } from "@/lib/routine-schedule.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useSystemBots } from "@/lib/system-bots.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { WarningText } from "@/ui/warning-text.tsx";
import { ChatSidebar, Expandable, ShowMore, SidebarSection } from "./ChatSidebar.tsx";
import { ContextMeter, usedPercentOf } from "./ContextMeter.tsx";
import { LiveDesktopCard } from "./DesktopViewer.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { ParticipantAvatar } from "./ParticipantAvatar.tsx";
import { ProjectThreadActions, type ProjectThreadToChange } from "./ProjectThreadMenu.tsx";
import { SystemBotsNotSetUp } from "./SystemBotsNotSetUp.tsx";

/**
 * The Details' scrolling list: a column on a phone, and from a tablet up a
 * stack of floating cards, with room left for their shadows.
 */
const DETAILS_SCROLL =
	"tab-bar-clearance no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto pb-6 md:gap-2.5 md:p-2 md:pr-4";

/** How many rows a list shows before Show more. */
const FILES_SHOWN = 3;
const AUTOMATIONS_SHOWN = 2;
/** How big a bot's face is over a phone's Details, as a project's mark is there: `size-22`. */
const DETAILS_FACE_PX = 88;
/** A summary longer than this is folded to three lines until asked for the rest. */
const SUMMARY_FOLDED_OVER = 240;

/**
 * A bot beside its thread. On a phone: its face, name and model, and the way to
 * its settings and automations, then what the thread is about. From a tablet
 * up, floating cards: what the bot works with (its connections and how full
 * its short-term memory is), the files shared in the thread, and its computer.
 */
export function DetailsSidebar({
	bot,
	conversationId,
	contents,
	onOpenAutomations,
	onOpenDesktop,
	onClose,
}: {
	bot: Bot;
	conversationId: string;
	/** Who is in the conversation, and the files shared in it. */
	contents: ConversationContents;
	/** Opens the bot's automations beside the chat, in place of these Details: all of them, or the one `automationId` names. */
	onOpenAutomations: (automationId?: string) => void;
	/** Opens the bot's computer beside the chat. */
	onOpenDesktop: () => void;
	onClose: () => void;
}) {
	const backToThread = useBackToHere("Thread");
	const activity = useConversationActivity(conversationId).data;
	const summariser = useSystemBots().data?.find(({ key }) => key === "summarise");
	const modelName = useModelName(bot.model);
	return (
		<ChatSidebar label="Details" onClose={onClose} headerless floating>
			<div className={DETAILS_SCROLL}>
				{/* On a phone, the bot large in the middle, its name under it, then what can be done with it. */}
				<div className="flex flex-col items-center gap-2.5 px-4 pt-1 pb-4 text-center md:hidden">
					<BotAvatar
						color={bot.color}
						face={bot.face}
						shape={bot.shape}
						size={DETAILS_FACE_PX}
						className="shrink-0"
					/>
					<div className="flex min-w-0 flex-col gap-0.5 leading-snug">
						<h3 className="m-0 truncate font-semibold text-foreground text-xl">{bot.name}</h3>
						<p className="m-0 truncate text-sm text-subtle-foreground">
							{modelName ?? "No model chosen"}
						</p>
					</div>
					<div className="flex justify-center gap-7 pt-2">
						<RoundAction
							render={<Link {...botSettingsLink(bot)} state={backToThread} />}
							icon={<SettingsIcon size={20} />}
							label="Settings"
						/>
						<RoundAction
							render={<button type="button" onClick={() => onOpenAutomations()} />}
							icon={<RefreshCcw size={20} strokeWidth={1.75} />}
							label="Automations"
						/>
					</div>
				</div>
				{/* What a phone keeps under the bot; from a tablet up, the thread says it. */}
				<div className="contents md:hidden">
					<Summary
						summary={activity?.summary}
						summariserHasModel={summariser && summariser.model !== null}
					/>
				</div>
				<Context bot={bot} memory={activity?.context ?? undefined} />
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
				<Computer
					owner={{ bot }}
					bot={bot}
					conversationId={conversationId}
					onOpen={onOpenDesktop}
				/>
				{/* From a tablet up, automations are in the bot's sidebar. */}
				<div className="contents md:hidden">
					<Automations bot={bot} onOpen={onOpenAutomations} />
				</div>
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
				"focus-ring group/action flex w-16 flex-col items-center gap-1.5 rounded-xl text-xs text-soft-foreground",
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

/** Who is in a conversation, and the files shared in it, each opening where it is served. */
export interface ConversationContents {
	participants: readonly Participant[];
	/** The files in the messages loaded so far, oldest first: older pages add theirs as they load. */
	files: readonly FilePart[];
	fileUrlOf: (fileId: string) => string;
}

/**
 * One of a project's threads, beside it. On a phone: its project's mark, its
 * name, and renaming it and archiving it for whoever may. From a tablet up,
 * floating cards, as a bot's thread has: who is in it, the project's computer
 * and the files shared there.
 */
export function ProjectDetails({
	project,
	name,
	people,
	bots,
	toChange,
	user,
	contents,
	computer,
	onClose,
}: {
	project: Project;
	name: string;
	/** How many people and bots are in the project. */
	people: number;
	bots: number;
	/** The project's thread, for whoever may rename or archive it. */
	toChange?: ProjectThreadToChange;
	user: SessionUser;
	contents: ConversationContents;
	/**
	 * The project's computer, as its lead bot works on it in this thread, and
	 * opening its desktop; none while the project has no lead bot.
	 */
	computer?: { bot: Bot; conversationId: string; onOpen: () => void };
	onClose: () => void;
}) {
	return (
		<ChatSidebar label="Details" onClose={onClose} headerless floating>
			<div className={DETAILS_SCROLL}>
				{/* On a phone, the project's mark large in the middle, the thread's name under it, then what can be done with it. */}
				<div className="flex flex-col items-center gap-2.5 px-4 pt-1 pb-4 text-center md:hidden">
					<ProjectInitial project={project} size="xl" />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
						<h3 className="m-0 truncate font-semibold text-foreground text-xl">{name}</h3>
						<p className="m-0 truncate text-sm text-subtle-foreground">
							{project.name} · {projectHeadcount({ people, bots })}
						</p>
					</div>
					{toChange && (
						<ProjectThreadActions {...toChange}>
							{({ rename, archive }) => (
								<div className="flex justify-center gap-7 pt-2">
									<RoundAction
										render={<button type="button" onClick={rename} />}
										icon={<Pencil size={20} strokeWidth={1.75} />}
										label="Rename"
									/>
									<RoundAction
										render={<button type="button" onClick={archive} />}
										icon={<Archive size={20} strokeWidth={1.75} />}
										label="Archive"
									/>
								</div>
							)}
						</ProjectThreadActions>
					)}
				</div>
				<People participants={contents.participants} user={user} />
				{computer && <Computer owner={{ project }} {...computer} />}
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
			</div>
		</ChatSidebar>
	);
}

/** Everyone in the conversation, each bot and each person, the viewer named as you. */
function People({
	participants,
	user,
}: {
	participants: readonly Participant[];
	user: SessionUser;
}) {
	if (participants.length === 0) return null;
	return (
		<SidebarSection title="People">
			<ul className="m-0 flex list-none flex-col p-0">
				{participants.map((participant) => (
					<ParticipantRow key={participant.id} participant={participant} user={user} />
				))}
			</ul>
		</SidebarSection>
	);
}

/** The files shared in the conversation, newest first, each opening as it is served. */
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
							<span className="grid size-5.5 shrink-0 place-items-center rounded-sm border border-border-strong text-muted-foreground">
								<FileText aria-hidden size={12} strokeWidth={2} />
							</span>
							<span className="min-w-0 flex-1 truncate text-xs text-foreground max-md:text-sm">
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
	summariserHasModel,
}: {
	summary: ConversationSummary | null | undefined;
	/** `undefined` while the system bots load, so the unconfigured state is not flashed. */
	summariserHasModel: boolean | undefined;
}) {
	const [open, setOpen] = useState(false);
	if (summariserHasModel === false) {
		return (
			<SidebarSection title="Summary">
				<SystemBotsNotSetUp />
			</SidebarSection>
		);
	}
	const text = summary?.content;
	const folds = text !== undefined && text.length > SUMMARY_FOLDED_OVER;
	return (
		<SidebarSection title="Summary">
			{text ? (
				<div
					className={cn(
						"text-soft-foreground text-xs leading-normal",
						folds && !open && "line-clamp-3",
					)}
				>
					<MessageMarkdown text={text} mentionable={[]} writer="bot" />
				</div>
			) : (
				<p className="m-0 text-muted-foreground text-xs leading-normal">
					A summary will appear after the first reply.
				</p>
			)}
			{folds && <ShowMore open={open} onToggle={() => setOpen(!open)} />}
		</SidebarSection>
	);
}

function ParticipantRow({ participant, user }: { participant: Participant; user: SessionUser }) {
	return (
		<li className="flex h-7.5 items-center gap-2.5 max-md:h-11 max-md:gap-3">
			<span aria-hidden className="contents">
				<ParticipantAvatar participant={participant} size={22} />
			</span>
			<span className="min-w-0 flex-1 truncate text-xs text-foreground max-md:text-sm">
				{participant.name}
				{participant.id === user.id && <span className="text-subtle-foreground"> (you)</span>}
			</span>
			<span className="text-subtle-foreground text-xs">
				{participant.kind === "bot" ? "Bot" : "Person"}
			</span>
		</li>
	);
}

/**
 * The bot's automations, each opening beside the chat with its runs, with a switch to
 * pause or resume it for whoever may manage them, and See all, which opens
 * them all beside the chat.
 */
function Automations({
	bot,
	onOpen,
}: {
	bot: Bot;
	/** Opens the bot's automations beside the chat: all of them, or the one `automationId` names. */
	onOpen: (automationId?: string) => void;
}) {
	const automations = useAutomations(bot.defaultProjectId);
	const actions = useAutomationActions();
	const list = automations.data ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection
			title="Automations"
			end={
				<Button variant="quiet" size="text" className="rounded-sm" onClick={() => onOpen()}>
					See all
				</Button>
			}
		>
			<Expandable items={list} shown={AUTOMATIONS_SHOWN}>
				{(automation) => (
					<li key={automation.id} className="flex items-center gap-3 py-1 max-md:min-h-11">
						<button
							type="button"
							onClick={() => onOpen(automation.id)}
							className="focus-ring flex min-w-0 flex-1 flex-col rounded-sm text-left leading-snug hover:[&>span:first-child]:underline"
						>
							<span className="truncate text-xs text-foreground max-md:text-sm">
								{automation.name}
							</span>
							{automationStartsLabel(automation) && (
								<span className="truncate text-subtle-foreground text-xs">
									{automationStartsLabel(automation)}
								</span>
							)}
						</button>
						<Toggle
							label={`${automation.name} on`}
							checked={automation.state === "enabled"}
							disabled={
								!bot.permissions.resources.manageAutomations ||
								(actions.update.isPending &&
									actions.update.variables?.automationId === automation.id)
							}
							onChange={(on) =>
								actions.update.mutate({
									projectId: automation.projectId,
									automationId: automation.id,
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

/**
 * What the bot works with in the thread: the apps it can reach, which are its
 * connections, with how many of their tools it may use, each opening the
 * bot's settings, and how full its short-term memory is. A connection whose
 * sign-in expired says so instead, with a sign-in for someone who may.
 */
function Context({ bot, memory }: { bot: Bot; memory: ConversationContext | undefined }) {
	const backToThread = useBackToHere("Thread");
	const connections = useConnections(bot.defaultProjectId);
	const list =
		connections.data?.filter(
			(connection) => connection.signInExpired || usableToolCount(connection) > 0,
		) ?? [];
	if (list.length === 0 && !memory) return null;
	return (
		<SidebarSection title="Context">
			{list.length > 0 && (
				<div className="flex flex-col gap-0.5">
					<h4 className="m-0 font-normal text-subtle-foreground text-xs">Connections</h4>
					<ul className="m-0 flex list-none flex-col p-0">
						{list.map((connection) => (
							<li key={connection.id}>
								{connection.signInExpired ? (
									<ExpiredTool bot={bot} connection={connection} />
								) : (
									<Link
										{...botSettingsLink(bot)}
										state={backToThread}
										className="focus-ring -mx-1.5 flex h-7.5 items-center gap-2.5 rounded-md px-1.5 transition-colors hover:bg-row-hover max-md:h-11 max-md:gap-3 max-md:active:bg-row-selected"
									>
										<ConnectionMark
											presetId={connectionMarkFor(connection)}
											name={connection.name}
											size="md"
										/>
										<span className="min-w-0 flex-1 truncate text-xs text-foreground max-md:text-sm">
											{connection.name}
										</span>
										<span className="shrink-0 text-subtle-foreground text-xs">
											{countOf(usableToolCount(connection), "tool", "tools")}
										</span>
									</Link>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
			{memory && (
				<div className="flex flex-col gap-1.5 pt-1">
					<h4 className="m-0 flex font-normal text-subtle-foreground text-xs">
						<span className="flex-1">Memory</span>
						<span className="font-mono">{usedPercentOf(memory)}%</span>
					</h4>
					<ContextMeter context={memory} />
				</div>
			)}
		</SidebarSection>
	);
}

/**
 * The owner's computer, a bot's or a project's: its screen while `bot` is
 * using it, else whether it has one, opening the desktop beside the thread,
 * which says how to get one when it has none.
 */
function Computer({
	owner,
	bot,
	conversationId,
	onOpen,
}: {
	owner: ResourceOwner;
	/** The bot at work on it: the bot itself, or a project's lead bot. */
	bot: Bot;
	conversationId: string;
	onOpen: () => void;
}) {
	const hasComputer = useComputerGap(owner) === null;
	const inUse = useDesktopInUse(conversationId, bot.id);
	return (
		<SidebarSection title="Computer">
			{hasComputer && inUse ? (
				<LiveDesktopCard
					conversationId={conversationId}
					botId={bot.id}
					botName={bot.name}
					onOpen={onOpen}
				/>
			) : (
				<button
					type="button"
					onClick={onOpen}
					className="focus-ring flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg border border-border-strong text-subtle-foreground text-xs transition-colors hover:border-subtle-foreground hover:text-foreground"
				>
					<Monitor aria-hidden size={16} strokeWidth={1.75} />
					{hasComputer ? "Not running" : "No computer"}
				</button>
			)}
		</SidebarSection>
	);
}

/** A connection whose sign-in expired: its name, why the bot can't use it, and a sign-in for someone who may. */
function ExpiredTool({ bot, connection }: { bot: Bot; connection: Connection }) {
	const actions = useConnectionActions(bot.defaultProjectId);
	return (
		<div className="-mx-1.5 flex items-center gap-2.5 px-1.5 py-1 max-md:gap-3">
			<ConnectionMark presetId={connectionMarkFor(connection)} name={connection.name} size="md" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="truncate text-foreground text-xs max-md:text-sm">{connection.name}</span>
				<WarningText className="text-warning text-xs">Sign-in expired</WarningText>
			</div>
			{bot.permissions.resources.manageConnections && (
				<Button
					variant="secondary"
					size="sm"
					className="shrink-0"
					aria-label={`Sign in to ${connection.name}`}
					disabled={actions.signIn.isPending}
					onClick={() => actions.signIn.mutate({ connectionId: connection.id })}
				>
					Sign in
				</Button>
			)}
		</div>
	);
}

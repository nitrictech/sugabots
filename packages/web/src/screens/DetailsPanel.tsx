import { useRender } from "@base-ui/react/use-render";
import type {
	Bot,
	ChatContext,
	Connector,
	CurrentUser,
	FilePart,
	Participant,
	Project,
} from "@sugabots/contracts";
import { connectorMarkFor } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { FileText, Monitor, Pencil, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useAutomationActions, useAutomations } from "@/lib/automations.ts";
import { useChatContext } from "@/lib/chat-query.ts";
import { useComputerGap } from "@/lib/computer-providers.ts";
import { usableToolCount, useConnectorActions, useConnectors } from "@/lib/connectors.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { projectHeadcount } from "@/lib/project-headcount.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { automationStartsLabel } from "@/lib/routine-schedule.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { SpacedText } from "@/ui/spaced-text.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { WarningText } from "@/ui/warning-text.tsx";
import { ContextMeter, usedPercentOf } from "./ContextMeter.tsx";
import { LiveDesktopCard } from "./DesktopViewer.tsx";
import { ModelName } from "./ModelName.tsx";
import { ParticipantAvatar } from "./ParticipantAvatar.tsx";
import { ProjectChatActions, type ProjectChatToChange } from "./ProjectChatMenu.tsx";
import { Expandable, PanelSection, SidePanel } from "./SidePanel.tsx";

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

/**
 * A bot beside its chat. On a phone: its face, name and model, and the way to
 * its settings and automations. From a tablet up, floating cards: what the bot
 * works with (its connectors and how full its short-term memory is), the files
 * shared in the chat, and its computer.
 */
export function DetailsPanel({
	bot,
	chatId,
	contents,
	onOpenAutomations,
	onOpenDesktop,
	onClose,
}: {
	bot: Bot;
	chatId: string;
	/** Who is in the chat, and the files shared in it. */
	contents: ChatContents;
	/** Opens the bot's automations beside the chat, in place of these Details: all of them, or the one `automationId` names. */
	onOpenAutomations: (automationId?: string) => void;
	/** Opens the bot's computer beside the chat. */
	onOpenDesktop: () => void;
	onClose: () => void;
}) {
	const context = useChatContext(chatId).data;
	return (
		<SidePanel label="Details" onClose={onClose} headerless floating>
			<div className={DETAILS_SCROLL}>
				{/* On a phone, the bot large in the middle, its name under it, then what can be done with it. */}
				<div className="flex flex-col items-center gap-2.5 px-4 pt-1 pb-4 text-center md:hidden">
					<BotAvatar
						color={bot.color}
						eyes={bot.eyes}
						shape={bot.shape}
						size={DETAILS_FACE_PX}
						className="shrink-0"
					/>
					<div className="flex min-w-0 flex-col gap-0.5 leading-snug">
						<h3 className="m-0 truncate font-semibold text-foreground text-xl">{bot.name}</h3>
						<p className="m-0 truncate text-sm text-subtle-foreground">
							{bot.model ? <ModelName modelId={bot.model} /> : "No model chosen"}
						</p>
					</div>
					<div className="flex justify-center gap-7 pt-2">
						<RoundAction
							render={<Link {...botSettingsLink(bot)} />}
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
				<Context bot={bot} memory={context ?? undefined} />
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
				<Computer owner={{ bot }} bot={bot} chatId={chatId} onOpen={onOpenDesktop} />
				{/* From a tablet up, automations are in the bot's sidebar. */}
				<div className="contents md:hidden">
					<Automations bot={bot} onOpen={onOpenAutomations} />
				</div>
			</div>
		</SidePanel>
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

/** Who is in a chat, and the files shared in it, each opening where it is served. */
export interface ChatContents {
	participants: readonly Participant[];
	/** The files in the messages loaded so far, oldest first: older pages add theirs as they load. */
	files: readonly FilePart[];
	fileUrlOf: (fileId: string) => string;
}

/**
 * One of a project's chats, beside it. On a phone: its project's mark, its
 * name, and renaming it for whoever may. From a tablet up,
 * floating cards, as a bot's chat has: who is in it, the project's computer
 * and the files shared there.
 */
export function ProjectDetails({
	project,
	name,
	members,
	bots,
	toChange,
	signedIn,
	contents,
	computer,
	onClose,
}: {
	project: Project;
	name: string;
	/** How many members and bots are in the project. */
	members: number;
	bots: number;
	/** The project's chat, for whoever may rename it. */
	toChange?: ProjectChatToChange;
	signedIn: CurrentUser;
	contents: ChatContents;
	/**
	 * The project's computer, as its lead bot works on it in this chat, and
	 * opening its desktop.
	 */
	computer?: { bot: Bot; chatId: string; onOpen: () => void };
	onClose: () => void;
}) {
	return (
		<SidePanel label="Details" onClose={onClose} headerless floating>
			<div className={DETAILS_SCROLL}>
				{/* On a phone, the project's mark large in the middle, the chat's name under it, then what can be done with it. */}
				<div className="flex flex-col items-center gap-2.5 px-4 pt-1 pb-4 text-center md:hidden">
					<ProjectInitial project={project} size="xl" />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
						<h3 className="m-0 truncate font-semibold text-foreground text-xl">{name}</h3>
						<p className="m-0 truncate text-sm text-subtle-foreground">
							<SpacedText parts={[project.name, projectHeadcount({ members, bots })]} />
						</p>
					</div>
					{toChange && (
						<ProjectChatActions {...toChange}>
							{({ rename }) => (
								<div className="flex justify-center gap-7 pt-2">
									<RoundAction
										render={<button type="button" onClick={rename} />}
										icon={<Pencil size={20} strokeWidth={1.75} />}
										label="Rename"
									/>
								</div>
							)}
						</ProjectChatActions>
					)}
				</div>
				<Members participants={contents.participants} signedIn={signedIn} />
				{computer && <Computer owner={{ project }} {...computer} />}
				<SharedFiles files={contents.files} fileUrlOf={contents.fileUrlOf} />
			</div>
		</SidePanel>
	);
}

/** Everyone in the chat, each bot and each member, the viewer named as you. */
function Members({
	participants,
	signedIn,
}: {
	participants: readonly Participant[];
	signedIn: CurrentUser;
}) {
	if (participants.length === 0) return null;
	return (
		<PanelSection title="Members">
			<ul className="m-0 flex list-none flex-col p-0">
				{participants.map((participant) => (
					<ParticipantRow key={participant.id} participant={participant} signedIn={signedIn} />
				))}
			</ul>
		</PanelSection>
	);
}

/** The files shared in the chat, newest first, each opening as it is served. */
function SharedFiles({
	files,
	fileUrlOf,
}: {
	files: readonly FilePart[];
	fileUrlOf: (fileId: string) => string;
}) {
	if (files.length === 0) return null;
	return (
		<PanelSection title="Files">
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
		</PanelSection>
	);
}

function ParticipantRow({
	participant,
	signedIn,
}: {
	participant: Participant;
	signedIn: CurrentUser;
}) {
	return (
		<li className="flex h-7.5 items-center gap-2.5 max-md:h-11 max-md:gap-3">
			<span aria-hidden className="contents">
				<ParticipantAvatar participant={participant} size={22} />
			</span>
			<span className="min-w-0 flex-1 truncate text-xs text-foreground max-md:text-sm">
				{participant.name}
				{participant.id === signedIn.id && <span className="text-subtle-foreground"> (you)</span>}
			</span>
			<span className="text-subtle-foreground text-xs">
				{participant.kind === "bot" ? "Bot" : "Member"}
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
		<PanelSection
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
		</PanelSection>
	);
}

/**
 * What the bot works with in the chat: the apps it can reach, which are its
 * connectors, with how many of their tools it may use, each opening the
 * bot's settings, and how full its short-term memory is. A connector whose
 * sign-in expired says so instead, with a sign-in for someone who may.
 */
function Context({ bot, memory }: { bot: Bot; memory: ChatContext | undefined }) {
	const connectors = useConnectors(bot.defaultProjectId);
	const list =
		connectors.data?.filter(
			(connector) => connector.signInExpired || usableToolCount(connector) > 0,
		) ?? [];
	if (list.length === 0 && !memory) return null;
	return (
		<PanelSection title="Context">
			{list.length > 0 && (
				<div className="flex flex-col gap-0.5">
					<h4 className="m-0 font-normal text-subtle-foreground text-xs">Connectors</h4>
					<ul className="m-0 flex list-none flex-col p-0">
						{list.map((connector) => (
							<li key={connector.id}>
								{connector.signInExpired ? (
									<ExpiredTool bot={bot} connector={connector} />
								) : (
									<Link
										{...botSettingsLink(bot)}
										className="focus-ring -mx-1.5 flex h-7.5 items-center gap-2.5 rounded-md px-1.5 transition-colors hover:bg-row-hover max-md:h-11 max-md:gap-3 max-md:active:bg-row-selected"
									>
										<ConnectorMark
											markId={connectorMarkFor(connector)}
											name={connector.name}
											size="md"
										/>
										<span className="min-w-0 flex-1 truncate text-xs text-foreground max-md:text-sm">
											{connector.name}
										</span>
										<span className="shrink-0 text-subtle-foreground text-xs">
											{countOf(usableToolCount(connector), "tool", "tools")}
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
		</PanelSection>
	);
}

/**
 * The owner's computer, a bot's or a project's: its screen while `bot` is
 * using it, else whether it has one, opening the desktop beside the chat,
 * which says how to get one when it has none.
 */
function Computer({
	owner,
	bot,
	chatId,
	onOpen,
}: {
	owner: ResourceOwner;
	/** The bot at work on it: the bot itself, or a project's lead bot. */
	bot: Bot;
	chatId: string;
	onOpen: () => void;
}) {
	const hasComputer = useComputerGap(owner) === null;
	const inUse = useDesktopInUse(chatId, bot.id);
	return (
		<PanelSection title="Computer">
			{hasComputer && inUse ? (
				<LiveDesktopCard chatId={chatId} botId={bot.id} botName={bot.name} onOpen={onOpen} />
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
		</PanelSection>
	);
}

/** A connector whose sign-in expired: its name, why the bot can't use it, and a sign-in for someone who may. */
function ExpiredTool({ bot, connector }: { bot: Bot; connector: Connector }) {
	const actions = useConnectorActions(bot.defaultProjectId);
	return (
		<div className="-mx-1.5 flex items-center gap-2.5 px-1.5 py-1 max-md:gap-3">
			<ConnectorMark markId={connectorMarkFor(connector)} name={connector.name} size="md" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="truncate text-foreground text-xs max-md:text-sm">{connector.name}</span>
				<WarningText className="text-warning text-xs">Sign-in expired</WarningText>
			</div>
			{bot.permissions.resources.manageConnectors && (
				<Button
					variant="secondary"
					size="sm"
					className="shrink-0"
					aria-label={`Sign in to ${connector.name}`}
					disabled={actions.signIn.isPending}
					onClick={() => actions.signIn.mutate({ connectorId: connector.id })}
				>
					Sign in
				</Button>
			)}
		</div>
	);
}

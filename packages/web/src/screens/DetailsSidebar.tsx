import { botColorVariables } from "@sugabots/avatars";
import type {
	Agent,
	Pod,
	SessionUser,
	ThreadParticipant,
	ThreadSummary,
} from "@sugabots/contracts";
import { connectionPresetFor } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { RefreshCw, Settings2 } from "lucide-react";
import { useState } from "react";
import { useBuiltInAgents } from "@/lib/built-in-agents.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRoutineActions, useRoutines } from "@/lib/routines.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useThreadActivity } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { ScribeNotSetUp } from "./BuiltInAgentSetup.tsx";
import { ChatSidebar, Expandable, ShowMore, SidebarSection } from "./ChatSidebar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";

/** How many rows a list shows before Show more. */
const PARTICIPANTS_SHOWN = 3;
const ROUTINES_SHOWN = 2;
/** A summary longer than this is folded to four lines until asked for the rest. */
const SUMMARY_FOLDED_OVER = 240;

/**
 * A bot as a contact card, beside its chat: its face, name and pod, the way to
 * its settings, then what the chat is about, how much of the bot's short-term memory it
 * fills and who has been in it, the apps it can reach and the routines it runs.
 */
export function DetailsSidebar({
	agent,
	pod,
	threadId,
	user,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	threadId: string;
	user: SessionUser;
	onClose: () => void;
}) {
	const backToChat = useBackToHere("Chat");
	const activity = useThreadActivity(threadId).data;
	const scribe = useBuiltInAgents().data?.find(({ key }) => key === "summarise");
	return (
		<ChatSidebar label="Details" onClose={onClose}>
			<div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[18px] pt-5 pb-6">
				<div className="flex items-center gap-3.5" style={botColorVariables(agent.color)}>
					<AgentAvatar color={agent.color} face={agent.face} size={56} className="shrink-0" />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<h3 className="m-0 truncate font-bold text-[18px] text-foreground">{agent.name}</h3>
						<p className="m-0 truncate text-md text-muted-foreground">{pod.name} pod</p>
					</div>
				</div>
				<Link
					{...agentSettingsLink({ pod, agent })}
					state={backToChat}
					className="focus-ring flex h-9 items-center justify-center gap-2 rounded-[8px] border border-border-strong font-medium text-[13.5px] text-foreground transition-colors hover:bg-panel"
				>
					<Settings2 aria-hidden size={15} strokeWidth={2} className="text-soft-foreground" />
					Bot settings
				</Link>
				<Summary summary={activity?.summary} scribeHasModel={scribe && scribe.model !== null} />
				{activity?.context && (
					<SidebarSection title="Short-term memory">
						<ContextMeter context={activity.context} />
					</SidebarSection>
				)}
				{activity && activity.recentParticipants.length > 0 && (
					<SidebarSection title="Recent participants">
						<Expandable items={activity.recentParticipants} shown={PARTICIPANTS_SHOWN}>
							{(participant) => (
								<ParticipantRow key={participant.id} participant={participant} user={user} />
							)}
						</Expandable>
					</SidebarSection>
				)}
				<Routines pod={pod} agent={agent} />
				<Tools pod={pod} agent={agent} />
			</div>
		</ChatSidebar>
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
			<SidebarSection title="Summary" className="px-3.5 py-3">
				<ScribeNotSetUp />
			</SidebarSection>
		);
	}
	const text = summary?.content;
	const folds = text !== undefined && text.length > SUMMARY_FOLDED_OVER;
	return (
		<SidebarSection
			title="Summary"
			note={summary && `Updated ${formatListTime(new Date(summary.updatedAt), new Date())}`}
		>
			<p
				className={`m-0 px-3.5 py-3 text-[14px] leading-[1.55] ${text ? "text-foreground" : "text-muted-foreground"} ${folds && !open ? "line-clamp-4" : ""}`}
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
		<li className="flex items-center gap-2.5 border-border border-b px-3.5 py-[9px] last:border-b-0">
			<span aria-hidden className="contents">
				{participant.kind === "agent" ? (
					<AgentAvatar color={participant.color} face={participant.face} size={26} />
				) : (
					<PersonAvatar person={participant} size={26} />
				)}
			</span>
			<span className="min-w-0 flex-1 truncate text-[14px] text-foreground">
				{participant.name}
			</span>
			<span className="text-sm text-subtle-foreground">
				{participant.kind === "agent" ? "Bot" : participant.id === user.id ? "You" : "Member"}
			</span>
		</li>
	);
}

/**
 * The bot's routines, each opening the bot's settings at its routines, with a
 * switch to pause or resume it for whoever may manage them.
 */
function Routines({ pod, agent }: { pod: Pod; agent: Agent }) {
	const backToChat = useBackToHere("Chat");
	const routines = useRoutines(agent.id);
	const actions = useRoutineActions();
	const list = routines.data ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection title="Routines">
			<Expandable items={list} shown={ROUTINES_SHOWN}>
				{(routine) => (
					<li
						key={routine.id}
						className="flex items-center gap-2.5 border-border border-b pr-3.5 last:border-b-0"
					>
						<Link
							{...agentSettingsLink({ pod, agent })}
							state={backToChat}
							search={{ tab: "routines" }}
							className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-3.5 transition-colors hover:text-link"
						>
							<span className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-chip text-soft-foreground">
								<RefreshCw aria-hidden size={13} strokeWidth={2.2} />
							</span>
							<span className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="truncate text-[14px] text-foreground">{routine.name}</span>
								<span className="truncate text-subtle-foreground text-xs">
									{scheduleLabel(routine)}
								</span>
							</span>
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

/** The apps the bot can reach, which are its pod's connections, each opening the bot's settings. */
function Tools({ pod, agent }: { pod: Pod; agent: Agent }) {
	const backToChat = useBackToHere("Chat");
	const connections = useConnections(pod.id);
	const list = connections.data?.filter((connection) => usableToolCount(connection) > 0) ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection title="Tools" card={false} className="flex flex-wrap gap-1.5">
			{list.map((connection) => (
				<Link
					key={connection.id}
					{...agentSettingsLink({ pod, agent })}
					state={backToChat}
					className="focus-ring flex h-[30px] min-w-0 items-center gap-[7px] rounded-[8px] border border-border-strong pr-2.5 pl-1 font-medium text-[13px] text-soft-foreground transition-colors hover:bg-panel"
				>
					<ConnectionMark
						presetId={connectionPresetFor(connection.url)?.id}
						name={connection.name}
						size="md"
					/>
					<span className="truncate">{connection.name}</span>
				</Link>
			))}
		</SidebarSection>
	);
}

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
import { Repeat, Settings } from "lucide-react";
import { useState } from "react";
import { useBuiltInAgents } from "@/lib/built-in-agents.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRoutines } from "@/lib/routines.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useThreadActivity } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ScribeNotSetUp } from "./BuiltInAgentSetup.tsx";
import { ChatSidebar, Expandable, ShowMore, SidebarSection } from "./ChatSidebar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";

/** How many rows a list shows before Show more. */
const PARTICIPANTS_SHOWN = 3;
const ROUTINES_SHOWN = 2;
/** A summary longer than this is folded to three lines until asked for the rest. */
const SUMMARY_FOLDED_OVER = 180;

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
		<ChatSidebar label="Details" onClose={onClose} closedFromHeader className="bg-list">
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[18px] pb-6 md:pt-[22px]">
				<div
					className="flex flex-col items-center gap-2 text-center"
					style={botColorVariables(agent.color)}
				>
					<AgentAvatar color={agent.color} face={agent.face} size={80} />
					<h2 className="m-0 pt-1 font-bold text-foreground text-xl">{agent.name}</h2>
					<p className="m-0 text-[13.5px] text-muted-foreground">{pod.name} pod</p>
				</div>
				<div className="flex gap-2">
					<Link
						{...agentSettingsLink({ pod, agent })}
						state={backToChat}
						className="focus-ring flex flex-1 flex-col items-center gap-1.5 rounded-tile bg-chip px-1.5 py-3 text-soft-foreground transition-colors hover:bg-hover"
					>
						<Settings aria-hidden size={18} strokeWidth={2} />
						<span className="font-medium text-foreground text-sm">Settings</span>
					</Link>
				</div>
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
		<SidebarSection title="Summary">
			<p
				className={`m-0 px-3.5 py-3 text-[14px] leading-normal ${text ? "text-foreground" : "text-muted-foreground"} ${folds && !open ? "line-clamp-3" : ""}`}
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
		<li className="flex items-center gap-2.5 border-border-subtle border-b px-3.5 py-[9px] last:border-b-0">
			{participant.kind === "agent" ? (
				<AgentAvatar color={participant.color} face={participant.face} size={28} />
			) : (
				<PersonAvatar person={participant} size={28} />
			)}
			<span className="min-w-0 flex-1 truncate text-[14px] text-foreground">
				{participant.name}
			</span>
			{participant.kind === "person" && participant.id === user.id && (
				<span className="text-md text-muted-foreground">You</span>
			)}
		</li>
	);
}

/** Each routine opens the bot's settings at its routines. */
function Routines({ pod, agent }: { pod: Pod; agent: Agent }) {
	const backToChat = useBackToHere("Chat");
	const routines = useRoutines(agent.id);
	const list = routines.data ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection title="Routines">
			<Expandable items={list} shown={ROUTINES_SHOWN}>
				{(routine) => (
					<li key={routine.id} className="border-border-subtle border-b last:border-b-0">
						<Link
							{...agentSettingsLink({ pod, agent })}
							state={backToChat}
							search={{ tab: "routines" }}
							className="focus-ring flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-hover"
						>
							<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-border-strong text-soft-foreground">
								<Repeat aria-hidden size={14} strokeWidth={2.2} />
							</span>
							<span className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="truncate text-[14px] text-foreground">{routine.name}</span>
								<span className="truncate text-muted-foreground text-xs">
									{scheduleLabel(routine)}
								</span>
							</span>
						</Link>
					</li>
				)}
			</Expandable>
		</SidebarSection>
	);
}

/** The apps the bot can reach, which are its pod's connections. */
function Tools({ pod, agent }: { pod: Pod; agent: Agent }) {
	const backToChat = useBackToHere("Chat");
	const connections = useConnections(pod.id);
	const list = connections.data?.filter((connection) => usableToolCount(connection) > 0) ?? [];
	if (list.length === 0) return null;
	return (
		<SidebarSection title="Tools" className="flex flex-wrap items-center gap-2 px-3.5 py-3">
			{list.map((connection) => (
				<Tooltip key={connection.id} label={connection.name} side="top">
					<Link
						{...agentSettingsLink({ pod, agent })}
						state={backToChat}
						aria-label={connection.name}
						className="focus-ring rounded-[10px] transition-opacity hover:opacity-80"
					>
						<ConnectionMark
							presetId={connectionPresetFor(connection.url)?.id}
							name={connection.name}
							size="tile"
						/>
					</Link>
				</Tooltip>
			))}
		</SidebarSection>
	);
}

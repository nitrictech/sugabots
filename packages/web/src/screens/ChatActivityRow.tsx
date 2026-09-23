import type {
	ChatHistoryEntry,
	RoutineExecutionTriggerKind,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Ban, CalendarClock, ChevronRight, CircleAlert, Clock3, Play, Webhook } from "lucide-react";
import { AgentAvatar } from "@/shell/Agent.tsx";

export type ChatThreadType = ChatHistoryEntry["type"];

export const threadTypePresentation = {
	collaboration: { label: "Collaboration", color: "#33478f", tint: "#eef1fb" },
	routine: { label: "Routine run", color: "#7a3f0c", tint: "#fdf1e5" },
} as const;

export function ThreadTypeMark({
	type,
	triggerKind,
	size = 13,
}: {
	type: ChatThreadType;
	triggerKind?: RoutineExecutionTriggerKind;
	size?: number;
}) {
	const color = threadTypePresentation[type].color;
	if (type === "routine") {
		const Icon =
			triggerKind === "webhook" ? Webhook : triggerKind === "manual" ? Play : CalendarClock;
		return <Icon aria-hidden size={size} color={color} />;
	}
	return (
		<svg
			aria-hidden
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth="2"
		>
			<circle cx="9" cy="9" r="5" />
			<circle cx="16" cy="15" r="5" />
		</svg>
	);
}

export function ChatActivityRow({
	entry,
	type: explicitType,
	title,
	collaborationAgents,
	onOpen,
}: {
	entry?: ChatHistoryEntry;
	type?: ChatThreadType;
	title: string;
	collaborationAgents?: {
		initiator: Extract<ThreadParticipant, { kind: "agent" }>;
		recipient: Extract<ThreadParticipant, { kind: "agent" }>;
	};
	onOpen: () => void;
}) {
	const type: ChatThreadType = entry?.type ?? explicitType ?? "collaboration";
	const presentation = threadTypePresentation[type];
	return (
		<button
			type="button"
			onClick={onOpen}
			className="chat-activity-row focus-ring group flex w-full items-center gap-3 rounded-full px-1.5 py-1 text-left"
			aria-label={`Open ${presentation.label}: ${title}`}
		>
			<span aria-hidden className="h-px min-w-3 flex-1 bg-border-subtle" />
			<span className="flex min-w-0 max-w-[520px] items-center gap-2 text-sm text-muted-foreground">
				{!collaborationAgents && (
					<ThreadTypeMark type={type} triggerKind={entry?.routineExecution?.triggerKind} />
				)}
				{collaborationAgents ? (
					<span className="flex min-w-0 items-center gap-1.5 font-medium">
						<AgentAvatar
							hue={collaborationAgents.initiator.hue}
							face={collaborationAgents.initiator.face}
							size={18}
						/>
						<span className="truncate">{collaborationAgents.initiator.name}</span>
						<span className="shrink-0 font-normal text-subtle-foreground">talked to</span>
						<AgentAvatar
							hue={collaborationAgents.recipient.hue}
							face={collaborationAgents.recipient.face}
							size={18}
						/>
						<span className="truncate">{collaborationAgents.recipient.name}</span>
					</span>
				) : (
					<span className="min-w-0 truncate font-medium">{title}</span>
				)}
				{entry?.status === "running" && (
					<span
						className="chat-working-dots"
						title={type === "collaboration" ? "Agents working" : "Running"}
						style={{ color: presentation.color }}
					>
						<i />
						<i />
						<i />
					</span>
				)}
				{entry?.status === "queued" && <Clock3 aria-label="Queued" size={13} />}
				{entry?.status === "cancelled" && <Ban aria-label="Cancelled" size={13} />}
				{entry?.status === "failed" && (
					<CircleAlert aria-label="Failed" size={14} color="#a4453a" />
				)}
				{entry?.status === "completed" && (
					<time
						className="shrink-0 text-xs text-subtle-foreground"
						dateTime={entry.latestActivityAt}
					>
						{formatTime(entry.latestActivityAt)}
					</time>
				)}
				<ChevronRight aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
			</span>
			<span aria-hidden className="h-px min-w-3 flex-1 bg-border-subtle" />
		</button>
	);
}

function formatTime(value: string): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
		new Date(value),
	);
}

import type {
	ChatHistoryEntry,
	RoutineExecutionTriggerKind,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Clock, type LucideProps, RefreshCw, Webhook } from "lucide-react";
import { formatClockTime } from "@/lib/list-time.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";

export type ChatThreadType = ChatHistoryEntry["type"];

/** What each kind of thread is called where it is named. */
const threadTypeLabel = { collaboration: "Collaboration", routine: "Routine run" } as const;

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/** How a collaboration or routine run stands, as its line says it. */
export type ActivityState = "running" | "waiting_on_you" | "done" | "failed";

/** A history entry's status in the terms of the line. */
export function activityStateOf(entry: ChatHistoryEntry | undefined): ActivityState {
	if (entry?.status === "failed" || entry?.status === "cancelled") return "failed";
	if (entry?.status === "completed") return "done";
	return "running";
}

/**
 * A quiet row for something that happened in the chat around the bot's
 * messages: a collaboration another bot asked it into, or a routine run. It
 * lines up with the messages, its mark where their faces are, and the whole of
 * it opens the thread.
 */
export function ChatActivityRow(
	props: { state: ActivityState; at?: string; onOpen: () => void } & (
		| {
				type: "collaboration";
				initiator: AgentParticipant;
				recipient: AgentParticipant;
				/**
				 * Whose chat the row is in: the bot that asked, by default, or the
				 * one it asked, whose row says it helped.
				 */
				inChatOf?: "initiator" | "recipient";
		  }
		| { type: "routine"; routineName: string; triggerKind: RoutineExecutionTriggerKind }
	),
) {
	const { state, at, onOpen } = props;
	const text =
		props.type === "collaboration"
			? props.inChatOf === "recipient"
				? helpedText(props.recipient.name, props.initiator.name, state)
				: collaborationText(props.initiator.name, props.recipient.name, state)
			: routineText(props.routineName, state);
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Open ${threadTypeLabel[props.type]}: ${text}`}
			className="focus-ring group/activity flex w-full min-w-0 items-center gap-3.5 px-5 py-1.5 text-left"
		>
			<span aria-hidden className="grid w-9 shrink-0 place-items-center text-muted-foreground">
				{props.type === "collaboration" ? (
					<span className="relative h-[18px] w-[30px]">
						<AgentAvatar
							color={props.initiator.color}
							face={props.initiator.face}
							size={18}
							className="absolute top-0 left-0"
						/>
						<AgentAvatar
							color={props.recipient.color}
							face={props.recipient.face}
							size={18}
							className="absolute top-0 left-3 rounded-full shadow-[0_0_0_2px_var(--background)]"
						/>
					</span>
				) : state === "failed" ? (
					<span className="grid size-[15px] place-items-center rounded-full bg-destructive font-bold text-[10px] text-white leading-none">
						!
					</span>
				) : (
					<RoutineTriggerIcon kind={props.triggerKind} size={15} strokeWidth={2.2} />
				)}
			</span>
			<span className="min-w-0 truncate font-medium text-[13.5px] text-muted-foreground transition-colors group-hover/activity:text-soft-foreground">
				{text}
			</span>
			{state === "running" ? (
				<span aria-hidden className="typing-dots typing-dots-small shrink-0 text-muted-foreground">
					<i />
					<i />
					<i />
				</span>
			) : (
				at && (
					<time dateTime={at} className="shrink-0 text-subtle-foreground text-xs">
						{formatClockTime(new Date(at))}
					</time>
				)
			)}
		</button>
	);
}

/** What started a routine run, as a mark: a clock for its schedule, a hook for its webhook. */
export function RoutineTriggerIcon({
	kind,
	...props
}: { kind: RoutineExecutionTriggerKind } & LucideProps) {
	if (kind === "cron") return <Clock {...props} />;
	if (kind === "webhook") return <Webhook {...props} />;
	return <RefreshCw {...props} />;
}

export function collaborationText(host: string, other: string, state: ActivityState): string {
	switch (state) {
		case "running":
			return `${host} is talking to ${other}`;
		case "waiting_on_you":
			return `${host} is waiting on your approval`;
		case "done":
			return `${host} collaborated with ${other}`;
		case "failed":
			return `Collaboration with ${other} failed`;
	}
}

/** The same line in the chat of the bot that was asked, which it says it helped. */
function helpedText(helper: string, asker: string, state: ActivityState): string {
	switch (state) {
		case "running":
			return `${helper} is helping ${asker}`;
		case "waiting_on_you":
			return `${helper} is waiting on your approval`;
		case "done":
			return `${helper} helped ${asker}`;
		case "failed":
			return `Collaboration with ${asker} failed`;
	}
}

export function routineText(name: string, state: ActivityState): string {
	switch (state) {
		case "running":
			return `${name} is running`;
		case "waiting_on_you":
			return `${name} is waiting on your approval`;
		case "done":
			return `${name} ran`;
		case "failed":
			return `${name} failed`;
	}
}

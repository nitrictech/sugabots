import type { ChatActivityStatus, ChatHistoryEntry, ThreadParticipant } from "@sugabots/contracts";
import { ChevronRight, Repeat } from "lucide-react";
import { AgentAvatar } from "@/shell/Agent.tsx";

export type ChatThreadType = ChatHistoryEntry["type"];

/** What each kind of thread is called where it is named. */
const threadTypeLabel = { collaboration: "Collaboration", routine: "Routine run" } as const;

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/** How a collaboration or routine run stands, as its line says it. */
export type ActivityState = "running" | "waiting_on_you" | "done" | "failed";

/** A collaboration or routine run's status in the terms of the line. */
export function activityStateOf(status: ChatActivityStatus): ActivityState {
	if (status === "failed" || status === "cancelled") return "failed";
	if (status === "completed") return "done";
	return "running";
}

/**
 * A centred line for something that happened in the chat around the bot's
 * messages: a collaboration with another bot, or a routine run. The whole line
 * opens it.
 */
export function ChatActivityRow(
	props: { state: ActivityState; onOpen: () => void } & (
		| {
				type: "collaboration";
				initiator: AgentParticipant;
				recipient: AgentParticipant;
				/**
				 * Whose chat the line is in: the bot that asked, by default, or the
				 * one it asked, whose line says it helped.
				 */
				inChatOf?: "initiator" | "recipient";
		  }
		| { type: "routine"; routineName: string }
	),
) {
	const { state, onOpen } = props;
	const text =
		props.type === "collaboration"
			? props.inChatOf === "recipient"
				? helpedText(props.recipient.name, props.initiator.name, state)
				: collaborationText(props.initiator.name, props.recipient.name, state)
			: routineText(props.routineName, state);
	return (
		<div className="flex justify-center py-2.5">
			<button
				type="button"
				onClick={onOpen}
				aria-label={`Open ${threadTypeLabel[props.type]}: ${text}`}
				className="focus-ring flex min-w-0 items-center gap-[7px] rounded-md px-0.5 py-0.5 font-medium text-muted-foreground text-sm transition-colors hover:text-soft-foreground"
			>
				{props.type === "collaboration" ? (
					<span aria-hidden className="relative h-[18px] w-[30px] shrink-0">
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
					<span
						aria-hidden
						className="grid size-3.5 shrink-0 place-items-center rounded-full bg-destructive font-bold text-[10px] text-white leading-none"
					>
						!
					</span>
				) : (
					<Repeat aria-hidden size={13} strokeWidth={2.2} className="shrink-0" />
				)}
				<span className="min-w-0 truncate">{text}</span>
				{state === "running" ? (
					<span aria-hidden className="typing-dots typing-dots-small">
						<i />
						<i />
						<i />
					</span>
				) : (
					<ChevronRight
						aria-hidden
						size={10}
						strokeWidth={3}
						className="shrink-0 text-subtle-foreground"
					/>
				)}
			</button>
		</div>
	);
}

function collaborationText(host: string, other: string, state: ActivityState): string {
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

function routineText(name: string, state: ActivityState): string {
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

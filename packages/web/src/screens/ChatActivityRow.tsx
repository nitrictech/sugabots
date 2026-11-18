import type { ChatHistoryEntry, Participant, RunTriggerKind } from "@sugabots/contracts";
import { Clock, GitBranch, type LucideProps, RefreshCw, Webhook } from "lucide-react";
import { formatClockTime } from "@/lib/list-time.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { formatFullTimestamp } from "./ConversationMessages.tsx";

export type ItemConversationKind = ChatHistoryEntry["kind"];

/** What a collaboration or an automation run is called where it is named. */
const itemConversationLabel = (type: "collaboration" | "run") =>
	type === "collaboration" ? "Collaboration" : "Automation run";

type BotParticipant = Extract<Participant, { kind: "bot" }>;

/** How a collaboration or automation run stands, as its line says it. */
export type ActivityState = "running" | "done" | "failed";

/** A history entry's status in the terms of the line. */
export function activityStateOf(entry: ChatHistoryEntry | undefined): ActivityState {
	if (entry?.status === "failed" || entry?.status === "cancelled") return "failed";
	if (entry?.status === "completed") return "done";
	return "running";
}

/**
 * A quiet row for something that happened in the chat around the bot's
 * messages: a collaboration another bot asked it into, or an automation run. It
 * lines up with the messages, its mark where their faces are, and the whole of
 * it opens its conversation.
 */
export function ChatActivityRow(
	props: { state: ActivityState; at?: string; onOpen: () => void } & (
		| {
				type: "collaboration";
				initiator: BotParticipant;
				recipient: BotParticipant;
				/** What the bot was asked, after the line, quieter. */
				title?: string;
		  }
		| { type: "run"; automationName: string; triggerKind: RunTriggerKind }
	),
) {
	const { state, at, onOpen } = props;
	const text =
		props.type === "collaboration"
			? helpedText(props.recipient.name, props.initiator.name, state)
			: automationText(props.automationName, state);
	const detail = props.type === "collaboration" ? props.title : undefined;
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Open ${itemConversationLabel(props.type)}: ${[text, detail].filter(Boolean).join(", ")}`}
			className="focus-ring group/activity flex w-full min-w-0 items-center gap-3.5 px-5 py-1.5 text-left"
		>
			<span aria-hidden className="grid w-9 shrink-0 place-items-center text-muted-foreground">
				{props.type === "collaboration" ? (
					<span className="relative h-4.5 w-7.5">
						<BotAvatar
							color={props.initiator.color}
							face={props.initiator.face}
							shape={props.initiator.shape}
							size={18}
							className="absolute top-0 left-0"
						/>
						<BotAvatar
							color={props.recipient.color}
							face={props.recipient.face}
							shape={props.recipient.shape}
							size={18}
							ringed={{ color: "var(--background)", width: 2 }}
							className="absolute top-0 left-3"
						/>
					</span>
				) : state === "failed" ? (
					<span className="grid size-3.75 place-items-center rounded-full bg-destructive font-bold text-3xs text-white leading-none">
						!
					</span>
				) : (
					<AutomationTriggerIcon kind={props.triggerKind} size={15} strokeWidth={2.2} />
				)}
			</span>
			<span className="min-w-0 truncate font-medium text-xs text-muted-foreground transition-colors group-hover/activity:text-soft-foreground">
				{text}
			</span>
			{detail && (
				// Given only the room the line leaves, so the line, which says who is doing what, is cut short last.
				<span className="min-w-0 max-w-max grow basis-0 truncate text-xs text-subtle-foreground">
					{detail}
				</span>
			)}
			{state === "running" ? (
				<span aria-hidden className="typing-dots typing-dots-small shrink-0 text-muted-foreground">
					<i />
					<i />
					<i />
				</span>
			) : (
				at && (
					<Tooltip label={formatFullTimestamp(at)} side="top">
						<time dateTime={at} className="shrink-0 text-subtle-foreground text-xs">
							{formatClockTime(new Date(at))}
						</time>
					</Tooltip>
				)
			)}
		</button>
	);
}

/**
 * What started an automation run, as a mark: a clock for its schedule, a hook
 * for its webhook, a branch for its repository.
 */
export function AutomationTriggerIcon({ kind, ...props }: { kind: RunTriggerKind } & LucideProps) {
	if (kind === "schedule") return <Clock {...props} />;
	if (kind === "webhook") return <Webhook {...props} />;
	if (kind === "github") return <GitBranch {...props} />;
	return <RefreshCw {...props} />;
}

export function collaborationText(host: string, other: string, state: ActivityState): string {
	switch (state) {
		case "running":
			return `${host} is talking to ${other}`;
		case "done":
			return `${host} collaborated with ${other}`;
		case "failed":
			return `Collaboration with ${other} failed`;
	}
}

/** A collaboration as the bot that was asked tells it: that it is helping, or helped, the bot that asked. */
function helpedText(helper: string, asker: string, state: ActivityState): string {
	switch (state) {
		case "running":
			return `${helper} is helping ${asker}`;
		case "done":
			return `${helper} helped ${asker}`;
		case "failed":
			return `Collaboration with ${asker} failed`;
	}
}

export function automationText(name: string, state: ActivityState): string {
	switch (state) {
		case "running":
			return `${name} is running`;
		case "done":
			return `${name} ran`;
		case "failed":
			return `${name} failed`;
	}
}

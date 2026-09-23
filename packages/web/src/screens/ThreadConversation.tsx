import type {
	ChatHistoryEntry,
	CollaborationPart,
	Message,
	SessionUser,
	ThreadParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import { Fragment, type ReactNode, useMemo } from "react";
import { useConnectionLooks } from "@/lib/connections.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { ChatActivityRow } from "./ChatActivityRow.tsx";
import { CollaborationThread } from "./CollaborationThread.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { textWithMentions } from "./mentions.tsx";
import { DeniedToolLine, ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { TypingIndicator } from "./TypingIndicator.tsx";
import { isNarration, splitToolKey, toolActivityOf } from "./tool-activity.ts";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/*
 * A message is drawn as its parts, in order: text is a bubble and each
 * collaboration is the child thread it opened, at full width. So an agent that
 * writes, asks another agent, and writes again shows as a bubble, a child
 * thread, and a bubble, in the order it happened.
 *
 * A reply is drawn once it is finished, never as it streams. What the agent
 * writes on the way is often the lead-in to a tool call ("Let me find the
 * cycle:"), and that cannot be told until the call arrives, so a reply drawn
 * live would show words and then take them back. While the turn runs, one line
 * says the agent is typing, or which step it is on.
 *
 * Tool calls are not drawn as parts at all. They belong to the turn rather than
 * to the transcript, so once the reply lands they leave nothing behind — the
 * step count on the message's own action bar is the way to what they did. What
 * the agent said just before a call is narration and goes with them: the thread
 * shows the answer, and the activity log how it got there. The exception is a
 * write waiting to be approved, and one that was refused: those stopped or
 * changed the reply, so they stay in the thread, mid-turn included.
 */

export function ThreadConversation({
	messages,
	host,
	isRunning,
	mentionable,
	user,
	hostAgentOnRight = false,
	dividers = true,
	onOpenCollaboration,
	threadEntries = [],
	podId,
	canApproveToolCalls = false,
	canAlwaysAllowToolCalls = false,
}: {
	messages: Message[];
	host: AgentParticipant;
	isRunning: boolean;
	/** Everyone a mention in these messages could name. See `mentionableIn`. */
	mentionable: ThreadParticipant[];
	user: SessionUser;
	hostAgentOnRight?: boolean;
	/** Day and long-gap markers between messages; off where the thread is a short aside. */
	dividers?: boolean;
	/** Presents child work as a quiet activity row when the conversation owns a foreground panel. */
	onOpenCollaboration?: (threadId: string) => void;
	threadEntries?: ChatHistoryEntry[];
	podId: string;
	canApproveToolCalls?: boolean;
	canAlwaysAllowToolCalls?: boolean;
}) {
	const lastMessage = messages.at(-1);
	// The turn has started but its reply has not been created yet.
	const replyPending = isRunning && lastMessage?.author.kind === "person";
	const looks = useConnectionLooks(podId);
	const names = useMemo(
		() => new Map([...looks].map(([handle, look]) => [handle, look.name])),
		[looks],
	);
	return (
		<div className="flex flex-col gap-[17px]">
			{messages.map((message, index) => {
				const divider = dividers ? dividerBefore(messages[index - 1], message) : undefined;
				const activity = toolActivityOf(message, names);
				const outgoing =
					(message.author.kind === "person" && message.author.id === user.id) ||
					(hostAgentOnRight && message.author.kind === "agent" && message.author.id === host.id);
				const segments = segmentsOf(message);
				// Tool calls draw nothing, so the message's state and its action bar
				// belong to the last bubble rather than to the last part.
				const lastBubble = segments.findLastIndex((segment) => segment.type === "text");
				return (
					<Fragment key={message.id}>
						{divider && <ActivityDivider>{divider}</ActivityDivider>}
						{segments.map((segment, position) => {
							if (segment.type === "collaboration") {
								if (onOpenCollaboration) {
									const recipient = mentionable.find(
										(participant): participant is AgentParticipant =>
											participant.kind === "agent" &&
											participant.id === segment.collaboration.agentId,
									);
									return (
										<ChatActivityRow
											key={segment.key}
											entry={threadEntries.find(
												(entry) => entry.threadId === segment.collaboration.threadId,
											)}
											title={`${authorName(message)} talked to ${segment.collaboration.agentName}`}
											collaborationAgents={
												message.author.kind === "agent" && recipient
													? { initiator: message.author, recipient }
													: undefined
											}
											onOpen={() => onOpenCollaboration(segment.collaboration.threadId)}
										/>
									);
								}
								return (
									<CollaborationThread
										key={segment.key}
										collaboration={segment.collaboration}
										arrivedLive={message.status === "streaming"}
										user={user}
									/>
								);
							}
							if (segment.type === "tool_call") {
								const call = segment.toolCall;
								if (call.status === "awaiting_approval" && call.approval?.status === "pending") {
									return (
										<ToolApprovalCard
											key={segment.key}
											call={call}
											threadId={message.threadId}
											podId={podId}
											canApprove={canApproveToolCalls}
											canAlwaysAllow={canAlwaysAllowToolCalls}
											look={looks.get(splitToolKey(call.tool).handle)}
										/>
									);
								}
								if (call.approval?.status === "denied") {
									return (
										<DeniedToolLine
											key={segment.key}
											call={call}
											activity={activity}
											looks={looks}
											at={message.createdAt}
										/>
									);
								}
								// Every other call is the turn's own business: the log holds it.
								return null;
							}
							const isLast = position === lastBubble;
							return (
								<MessageBubble
									key={segment.key}
									message={message}
									text={segment.text}
									outgoing={outgoing}
									mentionable={mentionable}
									isLast={isLast}
									actions={
										isLast && message.author.kind === "agent" ? (
											<MessageActions
												text={textOf(message)}
												activity={activity}
												looks={looks}
												at={message.createdAt}
											/>
										) : undefined
									}
								/>
							);
						})}
						{message.author.kind === "agent" && isTyping(message) && (
							<TypingIndicator
								key={`${message.id}-typing`}
								agent={message.author}
								activity={activity}
								waitingOn={waitingOn(message)}
								looks={looks}
								outgoing={outgoing}
							/>
						)}
					</Fragment>
				);
			})}
			{replyPending && <TypingIndicator agent={host} outgoing={hostAgentOnRight} />}
		</div>
	);
}

/**
 * Whether a reply's turn is still going, so the typing line stands in for it.
 * A call waiting to be approved has its own card saying the turn is stopped on
 * it, and the line would say the same thing twice.
 */
function isTyping(message: Message): boolean {
	const awaitingApproval = message.parts.some(
		(part) => part.type === "tool_call" && part.status === "awaiting_approval",
	);
	return message.status === "streaming" && !awaitingApproval;
}

/** The collaborator a running reply has asked and not yet heard back from. */
function waitingOn(message: Message): string | undefined {
	const last = message.parts.at(-1);
	return last?.type === "collaboration" ? last.agentName : undefined;
}

/** A pending approval or a refusal: the only tool calls the thread draws. */
function drawsInThread(call: ToolCallPart): boolean {
	const pending = call.status === "awaiting_approval" && call.approval?.status === "pending";
	return pending || call.approval?.status === "denied";
}

/** What the message's bubbles say, narration left out, for the copy action. */
function textOf(message: Message): string {
	return message.parts
		.filter((_, index) => !isNarration(message.parts, index))
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

type Segment =
	| { type: "text"; key: string; text: string }
	| { type: "collaboration"; key: string; collaboration: CollaborationPart }
	| { type: "tool_call"; key: string; toolCall: ToolCallPart };

/**
 * The message's parts as things to draw, leaving out narration and every tool
 * call but a pending approval or a refusal. A reply still being written shows
 * only those and its collaborations: its text waits until it is finished.
 */
function segmentsOf(message: Message): Segment[] {
	const finished = message.status !== "streaming";
	// A text run is keyed by where in the message it starts; a collaboration or
	// tool call by its id.
	let written = 0;
	const segments: Segment[] = [];
	message.parts.forEach((part, index) => {
		if (part.type === "collaboration") {
			segments.push({ type: "collaboration", key: part.id, collaboration: part });
			return;
		}
		if (part.type === "tool_call") {
			if (drawsInThread(part)) segments.push({ type: "tool_call", key: part.id, toolCall: part });
			return;
		}
		if (finished && !isNarration(message.parts, index)) {
			segments.push({ type: "text", key: `text@${written}`, text: part.text });
		}
		written += part.text.length;
	});
	/*
	 * A reply that called a tool and wrote nothing has no text part at all —
	 * `messagePartsFor` adds none to empty content. It still needs a bubble: that
	 * is where its author, its time, a failure and the way into its activity all
	 * hang.
	 */
	if (finished && !segments.some((segment) => segment.type === "text")) {
		segments.push({ type: "text", key: `text@${written}`, text: "" });
	}
	return segments;
}

function MessageBubble({
	message,
	text,
	outgoing,
	mentionable,
	isLast,
	actions,
}: {
	message: Message;
	/** This bubble's run of text; a message with a collaboration in it has several. */
	text: string;
	outgoing: boolean;
	mentionable: ThreadParticipant[];
	/** Whether this is the message's last bubble, where a failure shows. */
	isLast: boolean;
	/** Copy and activity, shown beside the bubble's top on hover and on focus. */
	actions?: ReactNode;
}) {
	if (message.author.kind === "routine_trigger") {
		return <RoutineTriggerBubble message={message} text={text} />;
	}
	const agent = message.author.kind === "agent" ? message.author : undefined;
	const fromAgent = agent !== undefined;
	const status = messageStatus(message);
	/*
	 * Level with the name line, and sticky: on a reply taller than the screen the
	 * bar stays in view while any of it is, and leaves with it, since sticky
	 * never takes an element outside its parent.
	 */
	const pinnedActions = actions && <div className="sticky top-3 shrink-0 pt-2">{actions}</div>;
	return (
		<article
			aria-label={`${message.author.name}, ${status}`}
			className={`group/message agent-tint flex animate-rise items-start gap-1.5 motion-reduce:animate-none ${outgoing ? "justify-end pl-8 pr-3.5" : "justify-start pl-3.5 pr-8"}`}
			style={agent ? { ["--agent-hue" as string]: agent.hue } : undefined}
		>
			{outgoing && pinnedActions}
			<div className="relative max-w-[min(100%,480px)]">
				{message.author.kind === "agent" ? (
					<AgentAvatar
						hue={message.author.hue}
						face={message.author.face}
						size={38}
						ringed
						className={`absolute -top-[11px] z-10 ${outgoing ? "-right-[15px]" : "-left-[15px]"}`}
					/>
				) : (
					<PersonAvatar
						name={message.author.name}
						image={message.author.image}
						size={34}
						className={`absolute -top-[11px] z-10 border-[2.5px] border-card ${outgoing ? "-right-[15px]" : "-left-[15px]"}`}
					/>
				)}
				<div
					className={`min-w-0 rounded-4xl px-5 py-3.5 ${fromAgent ? "bg-agent-wash" : "bg-muted"}`}
				>
					<div
						className={`flex flex-wrap items-baseline gap-x-1.5 pb-1 font-semibold text-md ${
							outgoing ? "justify-end pr-5" : "pl-5"
						} ${fromAgent ? "text-agent-name" : "text-muted-foreground"}`}
					>
						<span>{message.author.name}</span>
						<span aria-hidden>·</span>
						<time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
					</div>
					{fromAgent ? (
						<MessageMarkdown text={text} mentionable={mentionable} />
					) : (
						<p className="m-0 whitespace-pre-wrap break-words text-foreground text-xl leading-relaxed">
							{textWithMentions(text, mentionable)}
						</p>
					)}
					{isLast && message.status === "failed" && (
						<p className="m-0 pt-2 text-destructive text-xs">
							<span className="font-semibold">Reply failed</span>
							{message.error && <span className="font-normal"> · {message.error}</span>}
						</p>
					)}
					{isLast && message.status === "cancelled" && (
						<p className="m-0 pt-2 font-semibold text-subtle-foreground text-xs">Reply stopped</p>
					)}
				</div>
			</div>
			{!outgoing && pinnedActions}
		</article>
	);
}

function RoutineTriggerBubble({ message, text }: { message: Message; text: string }) {
	if (message.author.kind !== "routine_trigger") return null;
	const source =
		message.author.triggerKind === "cron"
			? "Scheduled trigger"
			: message.author.triggerKind === "webhook"
				? "Webhook trigger"
				: "Manual run";
	return (
		<article aria-label={`${source} for ${message.author.routineName}`} className="px-3.5">
			<div className="rounded-2xl border border-border-subtle bg-sunken px-4 py-3">
				<div className="pb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
					{source} · {message.author.routineName}
				</div>
				<p className="m-0 whitespace-pre-wrap break-words text-foreground text-md leading-relaxed">
					{text}
				</p>
			</div>
		</article>
	);
}

function authorName(message: Message): string {
	return message.author.kind === "routine_trigger"
		? message.author.routineName
		: message.author.name;
}

function ActivityDivider({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-3">
			<span className="h-px flex-1 bg-border-subtle" />
			<span className="rounded-full bg-sunken px-3 py-1 font-semibold text-muted-foreground text-xs">
				{children}
			</span>
			<span className="h-px flex-1 bg-border-subtle" />
		</div>
	);
}

function dividerBefore(previous: Message | undefined, current: Message): string | undefined {
	const currentDate = new Date(current.createdAt);
	if (!previous) {
		return formatDay(currentDate);
	}
	const previousDate = new Date(previous.createdAt);
	if (!sameDay(previousDate, currentDate)) {
		return formatDay(currentDate);
	}
	const gapMinutes = Math.floor((currentDate.getTime() - previousDate.getTime()) / 60_000);
	if (gapMinutes < 30) {
		return undefined;
	}
	if (gapMinutes < 60) {
		return `${gapMinutes} minutes later`;
	}
	const hours = Math.round(gapMinutes / 60);
	return `${hours} ${hours === 1 ? "hour" : "hours"} later`;
}

function formatDay(date: Date): string {
	const today = new Date();
	if (sameDay(date, today)) {
		return "Today";
	}
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (sameDay(date, yesterday)) {
		return "Yesterday";
	}
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

function sameDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function formatTime(createdAt: string): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
		new Date(createdAt),
	);
}

function messageStatus(message: Message): string {
	if (message.status === "failed") {
		return "failed";
	}
	if (message.status === "cancelled") {
		return "stopped";
	}
	return formatTime(message.createdAt);
}

import { botColorVariables } from "@sugabots/avatars";
import type {
	CollaborationPart,
	Message,
	SessionUser,
	ThreadParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Fragment, type ReactNode, useRef } from "react";
import { useConnectionLooks } from "@/lib/connections.ts";
import { formatClockTime } from "@/lib/list-time.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { type ActivityState, ChatActivityRow } from "./ChatActivityRow.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { ToolLine } from "./ToolLine.tsx";
import { TypingIndicator } from "./TypingIndicator.tsx";
import { awaitsApproval, isNarration, splitToolKey } from "./tool-activity.ts";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/*
 * A message is drawn as its parts, in order: text is a bubble and each
 * collaboration is the child thread it opened, at full width. So an agent that
 * writes, asks another agent, and writes again shows as a bubble, a child
 * thread, and a bubble, in the order it happened.
 *
 * A reply's text is drawn once it is settled, never as it streams. What the
 * agent writes on the way is often the lead-in to a tool call ("Let me find
 * the cycle:"), and that cannot be told until the call arrives, so text drawn
 * live would show words and then take them back. Text is settled when the
 * reply finishes or when something follows it: text before a collaboration is
 * shown while the collaboration runs, so the thread reads in the order it
 * happened. While the turn runs, one line says the agent is typing, or which
 * step it is on.
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
	participants,
	user,
	rightAgentId,
	dividers = true,
	onOpenCollaboration,
	podId,
	canApproveToolCalls = false,
	compact = false,
	approvalsPinned = false,
	queued = NONE_QUEUED,
}: {
	messages: Message[];
	host: AgentParticipant;
	isRunning: boolean;
	/** Everyone in the thread, which is how a collaboration's other bot is found. */
	participants: ThreadParticipant[];
	user: SessionUser;
	/**
	 * The bot whose messages sit on the right, as a person's own do: in a
	 * collaboration, the bot whose chat it was opened from. None elsewhere.
	 */
	rightAgentId?: string;
	/**
	 * Day and long-gap markers between messages. Off where the caller places its
	 * own, as the chat does between these messages and its activity rows.
	 */
	dividers?: boolean;
	/** Opens a collaboration from its line, in the sidebar beside this conversation. */
	onOpenCollaboration: (threadId: string) => void;
	podId: string;
	canApproveToolCalls?: boolean;
	/** Whether, on a phone, the caller pins Allow and Deny below the thread instead of on each card. */
	approvalsPinned?: boolean;
	/**
	 * The sidebar's narrower thread: smaller faces and bubbles, and no names,
	 * since a collaboration has only its two bots and its header names them.
	 */
	compact?: boolean;
	/**
	 * People's messages that wait for the next reply, because one is still being
	 * written: `queuedBehindReply` over the whole conversation, not only these
	 * messages, since the reply may sit in an earlier run of them.
	 */
	queued?: ReadonlySet<string>;
}) {
	const lastMessage = messages.at(-1);
	// The turn has started but its reply has not been created yet.
	const replyPending = isRunning && lastMessage?.author.kind === "person";
	const looks = useConnectionLooks(podId);
	const watchedWritten = useRepliesWatchedBeingWritten(messages);
	const breaks = messages.map(
		(message, index) => dividers && separatesFrom(messages[index - 1], message),
	);
	// Whether the current run's name is placed yet. It goes above the run's
	// first bubble, not above a centred collaboration line that leads it.
	let runNamed = false;
	return (
		<div className="flex flex-col gap-1">
			{messages.map((message, index) => {
				const divider = breaks[index];
				const previous = messages[index - 1];
				const next = messages[index + 1];
				// A run is one author's messages in a row, with no marker between them.
				const continuesRun = previous !== undefined && !divider && sameAuthor(previous, message);
				const runContinues = next !== undefined && !breaks[index + 1] && sameAuthor(message, next);
				const calls = message.parts.filter(
					(part): part is ToolCallPart => part.type === "tool_call",
				);
				const outgoing =
					(message.author.kind === "person" && message.author.id === user.id) ||
					(message.author.kind === "agent" && message.author.id === rightAgentId);
				const segments = segmentsOf(message);
				// Tool calls draw nothing, so the message's state and its action bar
				// belong to the last bubble rather than to the last part.
				const lastBubble = segments.findLastIndex((segment) => segment.type === "text");
				const mine = outgoing && message.author.kind === "person";
				const startsRun = !continuesRun;
				if (startsRun) runNamed = compact || mine;
				/** The run's name, the first time something of the run sits beside the face. */
				const nameOnce = () => {
					if (runNamed || message.author.kind === "routine_trigger") return null;
					runNamed = true;
					return (
						<div
							className={cn(
								"pb-[3px] font-medium text-[11.5px] text-muted-foreground",
								outgoing ? "pr-[50px] text-right" : "pl-[50px]",
							)}
						>
							{message.author.name}
						</div>
					);
				};
				return (
					<Fragment key={message.id}>
						{divider && <DaySeparator at={message.createdAt} />}
						{startsRun && <span aria-hidden className="h-2.5" />}
						{message.author.kind === "agent" && calls.length > 0 && nameOnce()}
						{message.author.kind === "agent" && (
							<ToolLine
								calls={calls}
								looks={looks}
								className={
									compact
										? outgoing
											? "items-end pr-[34px]"
											: "pl-[34px]"
										: outgoing
											? "items-end pr-[50px]"
											: "pl-[50px]"
								}
							/>
						)}
						{segments.map((segment, position) => {
							if (segment.type === "collaboration") {
								const recipient = participants.find(
									(participant): participant is AgentParticipant =>
										participant.kind === "agent" &&
										participant.id === segment.collaboration.agentId,
								);
								if (message.author.kind !== "agent" || !recipient) return null;
								return (
									<ChatActivityRow
										key={segment.key}
										type="collaboration"
										initiator={message.author}
										recipient={recipient}
										state={collaborationState(segment.collaboration)}
										onOpen={() => onOpenCollaboration(segment.collaboration.threadId)}
									/>
								);
							}
							if (segment.type === "tool_call") {
								const call = segment.toolCall;
								const pending = awaitsApproval(call);
								// Only an agent calls tools; the check narrows the author for the card.
								if (pending && message.author.kind === "agent") {
									return (
										<Fragment key={segment.key}>
											{nameOnce()}
											<ToolApprovalCard
												call={call}
												agent={message.author}
												threadId={message.threadId}
												podId={podId}
												canApprove={canApproveToolCalls}
												answerPinned={approvalsPinned}
												outgoing={outgoing}
												look={looks.get(splitToolKey(call.tool).handle)}
											/>
										</Fragment>
									);
								}
								// Every other call is on the tool line above the message.
								return null;
							}
							const isLast = position === lastBubble;
							return (
								<Fragment key={segment.key}>
									{nameOnce()}
									<MessageBubble
										message={message}
										text={segment.text}
										outgoing={outgoing}
										endsRun={isLast && !runContinues && !isTyping(message)}
										isLast={isLast}
										compact={compact}
										arrivedLive={watchedWritten.has(message.id)}
										queued={queued.has(message.id)}
									/>
								</Fragment>
							);
						})}
						{message.author.kind === "agent" && isTyping(message) && nameOnce()}
						{message.author.kind === "agent" && isTyping(message) && (
							<TypingIndicator
								key={`${message.id}-typing`}
								agent={message.author}
								outgoing={outgoing}
								compact={compact}
							/>
						)}
					</Fragment>
				);
			})}
			{replyPending && (
				<TypingIndicator agent={host} outgoing={host.id === rightAgentId} compact={compact} />
			)}
		</div>
	);
}

/**
 * The ids of replies this thread has seen while they were still being written.
 * One that is finished and in here arrived while someone watched, as opposed
 * to being loaded with the thread's history. Only ever added to, so a reply
 * keeps its arrival for as long as the thread stays open.
 */
function useRepliesWatchedBeingWritten(messages: readonly Message[]): ReadonlySet<string> {
	const seen = useRef(new Set<string>());
	for (const message of messages) {
		if (message.status === "streaming") seen.current.add(message.id);
	}
	return seen.current;
}

const NONE_QUEUED: ReadonlySet<string> = new Set();

/** How long a reply takes to grow to fit its words: longer for more of them, within bounds. */
const REVEAL_MS = { minimum: 400, maximum: 700, perCharacter: 0.5 };

function revealDurationMs(text: string): number {
	const scaled = REVEAL_MS.minimum + text.length * REVEAL_MS.perCharacter;
	return Math.round(Math.min(scaled, REVEAL_MS.maximum));
}

/**
 * Whether a reply's turn is still going, so the typing line stands in for it.
 * A call waiting to be approved has its own card saying the turn is stopped on
 * it, and the line would say the same thing twice.
 */
function isTyping(message: Message): boolean {
	// While a collaboration runs the bot is quiet in its own chat; the collaboration line says so.
	if (waitingOn(message)) return false;
	const awaitingApproval = message.parts.some(
		(part) => part.type === "tool_call" && awaitsApproval(part),
	);
	return message.status === "streaming" && !awaitingApproval;
}

/** A collaboration's status in the terms of its line. */
function collaborationState(collaboration: CollaborationPart): ActivityState {
	switch (collaboration.status) {
		case "waiting":
			return "running";
		case "pending":
			return "waiting_on_you";
		case "answered":
			return "done";
		default:
			return "failed";
	}
}

/** The collaborator a running reply has asked and not yet heard back from. */
function waitingOn(message: Message): string | undefined {
	const last = message.parts.at(-1);
	return last?.type === "collaboration" ? last.agentName : undefined;
}

type Segment =
	| { type: "text"; key: string; text: string }
	| { type: "collaboration"; key: string; collaboration: CollaborationPart }
	| { type: "tool_call"; key: string; toolCall: ToolCallPart };

/**
 * The message's parts as things to draw, leaving out narration and every tool
 * call but a pending approval or a refusal. A reply still being written shows
 * only those, its collaborations, and text that something has followed: the
 * run it is still writing waits until it is finished.
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
			// A call waiting for approval is the only one drawn among the bubbles, as its card.
			if (awaitsApproval(part)) segments.push({ type: "tool_call", key: part.id, toolCall: part });
			return;
		}
		const followed = index < message.parts.length - 1 && part.text.trim() !== "";
		const settled = finished || followed;
		if (settled && !isNarration(message.parts, index)) {
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
	endsRun,
	isLast,
	arrivedLive,
	compact,
	queued,
}: {
	message: Message;
	/** This bubble's run of text; a message with a collaboration in it has several. */
	text: string;
	outgoing: boolean;
	/** The last bubble of its author's run, which carries the author's face. */
	endsRun: boolean;
	/** Whether this is the message's last bubble, where a failure shows. */
	isLast: boolean;
	/** Finished while the thread was open, so it arrives rather than simply being there. */
	arrivedLive: boolean;
	compact: boolean;
	/** Whether this message waits for the next reply, because one is still being written. */
	queued: boolean;
}) {
	if (message.author.kind === "routine_trigger") {
		return <RoutineTriggerBubble message={message} text={text} />;
	}
	const agent = message.author.kind === "agent" ? message.author : undefined;
	const mine = !agent && outgoing;
	const face = mine ? undefined : outgoing ? "right" : "left";
	const status = messageStatus(message, { queued });
	const bubble = cn(
		compact
			? "max-w-[380px] px-3.5 py-[9px] text-[14.5px]"
			: "max-w-[520px] px-[15px] py-2.5 text-lg",
		outgoing ? "rounded-[20px_20px_6px_20px]" : "rounded-[20px_20px_20px_6px]",
		agent
			? "bg-bot-tint text-bot-text"
			: mine
				? "bg-primary text-white"
				: "bg-bubble-human text-foreground",
	);
	return (
		<article
			aria-label={`${message.author.name}, ${status}`}
			className={cn(
				"group/message flex flex-col motion-reduce:animate-none",
				outgoing ? "items-end" : "items-start",
				arrivedLive
					? `animate-reply-in ${outgoing ? "origin-bottom-right" : "origin-bottom-left"}`
					: "animate-rise",
			)}
			style={agent ? botColorVariables(agent.color) : undefined}
		>
			<div className={cn("flex w-full items-end gap-2", outgoing && "flex-row-reverse")}>
				{!mine && (
					<span className={cn("flex shrink-0", compact ? "w-[26px]" : "w-[34px]")}>
						{endsRun &&
							(agent ? (
								<AgentAvatar color={agent.color} face={agent.face} size={compact ? 26 : 34} />
							) : (
								<PersonAvatar
									name={message.author.name}
									image={message.author.kind === "person" ? message.author.image : null}
									size={compact ? 26 : 34}
								/>
							))}
					</span>
				)}
				<div
					className={cn(
						"relative min-w-0",
						compact ? "max-w-[calc(100%-40px)]" : "max-w-[calc(100%-60px)]",
					)}
				>
					<div className={bubble}>
						{agent && arrivedLive ? (
							<div
								className="reply-grow"
								style={{ ["--reveal-duration" as string]: `${revealDurationMs(text)}ms` }}
							>
								<div>
									<MessageMarkdown text={text} />
								</div>
							</div>
						) : agent ? (
							<MessageMarkdown text={text} />
						) : (
							<p className="m-0 whitespace-pre-wrap break-words">{text}</p>
						)}
					</div>
					{/* The time shows only while the bubble is hovered or holds the focus. */}
					<div
						className={cn(
							"absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100",
							outgoing ? "right-[calc(100%+8px)]" : "left-[calc(100%+8px)]",
						)}
					>
						<time
							dateTime={message.createdAt}
							title={formatFullTimestamp(message.createdAt)}
							className="whitespace-nowrap text-subtle-foreground text-xs"
						>
							{formatTime(message.createdAt)}
						</time>
					</div>
				</div>
			</div>
			{isLast && message.status === "failed" && (
				<BubbleNote face={face} compact={compact} className="text-destructive-text">
					<span className="font-semibold">Reply failed.</span>
					{message.error && <span> {message.error}</span>}
				</BubbleNote>
			)}
			{isLast && message.status === "cancelled" && (
				<BubbleNote face={face} compact={compact} className="font-semibold text-subtle-foreground">
					Reply stopped
				</BubbleNote>
			)}
			{/*
			 * One note per person's run, under its last bubble. It stays in the page while
			 * folded, so it can fold away when the bot takes the messages up.
			 */}
			{endsRun && message.author.kind === "person" && (
				<div
					className={cn(
						"grid",
						// Only folding is animated: a message waiting shows it at once.
						queued
							? "grid-rows-[1fr]"
							: "invisible grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility] duration-300 ease-in motion-reduce:transition-none",
					)}
				>
					<div className="min-h-0 overflow-hidden">
						<BubbleNote face={face} compact={compact} className="text-subtle-foreground">
							Queued
						</BubbleNote>
					</div>
				</div>
			)}
		</article>
	);
}

/**
 * Where a note under a bubble starts, so it lines up with the bubble rather than
 * the face beside it: the face's width (34px, or 26px compact, in `MessageBubble`)
 * and the `gap-2` between them. Change them together.
 */
const NOTE_INSET = {
	left: { regular: "pl-[42px]", compact: "pl-[34px]" },
	right: { regular: "pr-[42px]", compact: "pr-[34px]" },
};

/** A line under a bubble, such as why a reply failed, clear of the bubble's face if it has one. */
function BubbleNote({
	face,
	compact,
	className,
	children,
}: {
	/** The side the bubble's face is on; your own bubbles have none. */
	face: "left" | "right" | undefined;
	compact: boolean;
	className: string;
	children: ReactNode;
}) {
	const inset = face && NOTE_INSET[face][compact ? "compact" : "regular"];
	return <p className={cn("m-0 pt-1 text-xs", inset, className)}>{children}</p>;
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
			<div className="rounded-2xl border border-border-subtle bg-list px-4 py-3">
				<div className="pb-1 font-semibold text-muted-foreground text-xs">
					{message.author.routineName} <span className="font-normal">{source}</span>
				</div>
				<p className="m-0 whitespace-pre-wrap break-words text-foreground text-md leading-relaxed">
					{text}
				</p>
			</div>
		</article>
	);
}

/** Where a run of messages starts on a new day, or after an hour's quiet: "Today 6:04". */
export function DaySeparator({ at }: { at: string }) {
	return (
		// Room above it between messages, so what follows reads as a new stretch of the chat.
		<p className="m-0 pt-7 pb-3.5 text-center font-semibold text-subtle-foreground text-xs first:pt-1">
			<span className="text-soft-foreground">{formatDay(new Date(at))}</span> {formatTime(at)}
		</p>
	);
}

const LONG_QUIET_MS = 60 * 60_000;

/** Whether `current` starts on a new day or after an hour's quiet, and so wants a separator. */
export function separatesFrom(
	previous: { createdAt: string } | undefined,
	current: { createdAt: string },
): boolean {
	if (!previous) return true;
	const previousDate = new Date(previous.createdAt);
	const currentDate = new Date(current.createdAt);
	return (
		!sameDay(previousDate, currentDate) ||
		currentDate.getTime() - previousDate.getTime() >= LONG_QUIET_MS
	);
}

function sameAuthor(left: Message, right: Message): boolean {
	if (left.author.kind === "routine_trigger" || right.author.kind === "routine_trigger") {
		return false;
	}
	return left.author.kind === right.author.kind && left.author.id === right.author.id;
}

function shortDateFor(date: Date): Intl.DateTimeFormatOptions {
	return date.getFullYear() === new Date().getFullYear()
		? { month: "short", day: "numeric" }
		: dateWithYear;
}

const dateWithYear: Intl.DateTimeFormatOptions = {
	month: "short",
	day: "numeric",
	year: "numeric",
};

/** "Today", "Yesterday", or the date in `dateFormat`: by default the month and day, and the year only for another year. */
function formatDay(date: Date, dateFormat = shortDateFor(date)): string {
	const today = new Date();
	if (sameDay(date, today)) {
		return "Today";
	}
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (sameDay(date, yesterday)) {
		return "Yesterday";
	}
	return new Intl.DateTimeFormat(undefined, dateFormat).format(date);
}

/** For example "Today at 4:58:34 PM", "Aug 5 at 3:46:46 PM", or "Aug 5, 2025 at 3:46:46 PM". */
function formatFullTimestamp(createdAt: string): string {
	const date = new Date(createdAt);
	const dateFormat: Intl.DateTimeFormatOptions =
		date.getFullYear() === new Date().getFullYear()
			? { month: "short", day: "numeric" }
			: dateWithYear;
	const time = new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
	return `${formatDay(date, dateFormat)} at ${time}`;
}

function sameDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function formatTime(createdAt: string): string {
	return formatClockTime(new Date(createdAt));
}

function messageStatus(message: Message, { queued }: { queued: boolean }): string {
	if (queued) {
		return "queued";
	}
	if (message.status === "failed") {
		return "failed";
	}
	if (message.status === "cancelled") {
		return "stopped";
	}
	return formatTime(message.createdAt);
}

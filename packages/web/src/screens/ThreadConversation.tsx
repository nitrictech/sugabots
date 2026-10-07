import { botColorVariables } from "@sugabots/avatars";
import {
	type CollaborationPart,
	isNarration,
	type Message,
	type PersonParticipant,
	type RoutineResultOf,
	type ThreadParticipant,
	type ToolCallPart,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { Fragment, type MouseEvent, type ReactNode, useRef, useState } from "react";
import type { AuthorLink, PagedAuthor } from "@/lib/author-links.ts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { formatClockTime } from "@/lib/list-time.ts";
import { splitToolKey } from "@/lib/tool-names.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { textWithMentions } from "./mentions.tsx";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { ToolLine } from "./ToolLine.tsx";
import { anyoneTyping, type Typer, TypingIndicator } from "./TypingIndicator.tsx";
import { awaitsApproval } from "./tool-activity.ts";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/*
 * A message is drawn as a row: its author's face and name at the head of a
 * group, then its parts in order. Text is its words, and each collaboration is
 * a thread line opening the child thread it started. So an agent that writes,
 * asks another agent, and writes again shows as words, a thread line, and
 * words, in the order it happened.
 *
 * A reply's text is drawn once it is settled, never as it streams. What the
 * agent writes on the way is often the lead-in to a tool call ("Let me find
 * the cycle:"), and that cannot be told until the call arrives, so text drawn
 * live would show words and then take them back. Text is settled when the
 * reply finishes or when something follows it: text before a collaboration is
 * shown while the collaboration runs, so the thread reads in the order it
 * happened. While the turn runs, one line says the agent is typing.
 *
 * Tool calls are not drawn as parts at all. They belong to the turn rather than
 * to the transcript: the tool line above a reply is the way to what they did.
 * What the agent said just before a call is narration and goes with them. The
 * exception is a write somebody was asked to approve: it stopped the reply,
 * and whoever answered it may want to read again what they agreed to, so it
 * stays in the thread as its card, waiting or answered, mid-turn included.
 */

export function ThreadConversation({
	messages,
	host,
	isRunning,
	participants,
	dividers = true,
	onOpenThread,
	podId,
	canApproveToolCalls = false,
	compact = false,
	queued = NONE_QUEUED,
	peopleTyping = [],
	showsTyping = true,
	highlightedMessageId,
	threadActivityAt,
	authorLinkOf,
}: {
	messages: Message[];
	host: AgentParticipant;
	isRunning: boolean;
	/**
	 * Everyone in the thread and the pod's bots and people: how a
	 * collaboration's other bot is found, and who a mention can name.
	 */
	participants: ThreadParticipant[];
	/**
	 * Day markers between messages. Off where the caller places its own, as the
	 * chat does between these messages and its activity rows.
	 */
	dividers?: boolean;
	/**
	 * Opens a collaboration from its line, or the run a routine's result came
	 * from, in the sidebar beside this conversation.
	 */
	onOpenThread: (threadId: string) => void;
	podId: string;
	canApproveToolCalls?: boolean;
	/** The sidebar's narrower thread: smaller faces and words. */
	compact?: boolean;
	/**
	 * People's messages that wait for the next reply, because one is still being
	 * written: `queuedBehindReply` over the whole conversation, not only these
	 * messages, since the reply may sit in an earlier run of them.
	 */
	queued?: ReadonlySet<string>;
	/**
	 * Other people typing in the thread. They join a bot typing the last reply,
	 * or are shown after the last message on their own.
	 */
	peopleTyping?: readonly PersonParticipant[];
	/** Off where the caller says who is typing itself, as the chat does under its composer. */
	showsTyping?: boolean;
	/** A message pointed out for a moment, as one jumped to is. */
	highlightedMessageId?: string;
	/** When each collaboration a message opened last had something in it, by its thread's id. */
	threadActivityAt?: ReadonlyMap<string, string>;
	/** Where an author's name leads. Names are plain text without it. */
	authorLinkOf?: (author: PagedAuthor) => AuthorLink | undefined;
}) {
	const lastMessage = messages.at(-1);
	// The turn has started but its reply has not been created yet.
	const replyPending = isRunning && lastMessage?.author.kind === "person";
	const lastReplyTyping =
		lastMessage !== undefined && lastMessage.author.kind === "agent" && isTyping(lastMessage);
	const looks = useConnectionLooks(podId);
	const watchedWritten = useRepliesWatchedBeingWritten(messages);
	return (
		<div className="flex flex-col">
			{messages.map((message, index) => {
				const previous = messages[index - 1];
				const next = messages[index + 1];
				const divider = dividers && startsNewDay(previous?.createdAt, message.createdAt);
				// One note for each person's run of waiting messages, under the last of them.
				const queuedNote =
					queued.has(message.id) &&
					(next === undefined ||
						!queued.has(next.id) ||
						startsGroup(message, next) ||
						!sameDay(message, next));
				return (
					<Fragment key={message.id}>
						{divider && <DaySeparator at={message.createdAt} />}
						{message.author.kind === "routine_trigger" ? (
							<RoutineTriggerCard message={message} />
						) : (
							<MessageRow
								message={message}
								startsGroup={divider || startsGroup(previous, message)}
								participants={participants}
								looks={looks}
								podId={podId}
								canApproveToolCalls={canApproveToolCalls}
								compact={compact}
								arrivedLive={watchedWritten.has(message.id)}
								queued={queued.has(message.id)}
								queuedNote={queuedNote}
								highlighted={message.id === highlightedMessageId}
								threadActivityAt={threadActivityAt}
								authorLink={authorLinkOf?.(message.author)}
								onOpenThread={onOpenThread}
							/>
						)}
						{showsTyping && message.author.kind === "agent" && isTyping(message) && (
							<TypingIndicator
								key={`${message.id}-typing`}
								typers={
									message === lastMessage ? [message.author, ...peopleTyping] : [message.author]
								}
							/>
						)}
					</Fragment>
				);
			})}
			{showsTyping &&
				(replyPending ? (
					<TypingIndicator typers={[host, ...peopleTyping]} />
				) : (
					!lastReplyTyping &&
					anyoneTyping(peopleTyping) && <TypingIndicator typers={peopleTyping} />
				))}
		</div>
	);
}

/**
 * Who is typing after `messages`: the bot writing the last of them, and the
 * people writing in the composer.
 */
export function typersAfter(
	messages: readonly Message[],
	peopleTyping: readonly PersonParticipant[],
): Typer[] {
	const last = messages.at(-1);
	if (last?.author.kind === "agent" && isTyping(last)) return [last.author, ...peopleTyping];
	return [...peopleTyping];
}

/**
 * Whether `message` heads a group of its own, with its author's face and name:
 * a new author, an hour's quiet, or a message after one that opened a
 * collaboration, whose thread line ends that group.
 */
function startsGroup(previous: Message | undefined, message: Message): boolean {
	if (!previous || !sameAuthor(previous, message)) return true;
	if (previous.parts.some((part) => part.type === "collaboration")) return true;
	return (
		new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() >= LONG_QUIET_MS
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

/** Screens that cannot hover, which is to say touch screens. */
const NO_HOVER = "(hover: none)";

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

/** The collaborator a running reply has asked and not yet heard back from. */
function waitingOn(message: Message): string | undefined {
	const last = message.parts.at(-1);
	return last?.type === "collaboration" ? last.agentName : undefined;
}

/** Whether a person was asked to allow the call, rather than policy allowing it on its own. */
function wasPutToSomeone(call: ToolCallPart): boolean {
	const status = call.approval?.status;
	return status === "pending" || status === "allowed" || status === "denied";
}

type Segment =
	| { type: "text"; key: string; text: string }
	| { type: "collaboration"; key: string; collaboration: CollaborationPart }
	| { type: "tool_call"; key: string; toolCall: ToolCallPart };

/**
 * The message's parts as things to draw, leaving out narration and every tool
 * call but those somebody was asked to approve. A reply still being written shows
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
			// A call somebody had to answer is the only one drawn among the bubbles, as its card.
			if (wasPutToSomeone(part)) segments.push({ type: "tool_call", key: part.id, toolCall: part });
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

/** How each part of a row is sized: the regular chat, or the sidebar's narrower thread. */
const ROW = {
	regular: { face: 36, row: "gap-3.5 px-5", words: "text-[15px] leading-[1.5]" },
	compact: { face: 32, row: "gap-3 px-[18px]", words: "text-[14.5px] leading-[1.5]" },
} as const;

/**
 * One message as a row: at the head of a group its author's face, name and
 * time, then its words, any collaboration it opened as a thread line, and any
 * call somebody was asked to approve as its card. Hovered, it lifts slightly,
 * shows its time beside a follow-up, and offers to copy its words.
 */
function MessageRow({
	message,
	startsGroup,
	participants,
	looks,
	podId,
	canApproveToolCalls,
	compact,
	arrivedLive,
	queued,
	queuedNote,
	highlighted,
	threadActivityAt,
	authorLink,
	onOpenThread,
}: {
	message: Message;
	/** Whether it heads its author's group, so it carries their face and name. */
	startsGroup: boolean;
	participants: ThreadParticipant[];
	looks: ReturnType<typeof useConnectionLooks>;
	podId: string;
	canApproveToolCalls: boolean;
	compact: boolean;
	/** Finished while the thread was open, so it arrives rather than simply being there. */
	arrivedLive: boolean;
	/** Whether this message waits for the next reply, because one is still being written. */
	queued: boolean;
	/** Whether it ends a run of waiting messages, which says so once under the last of them. */
	queuedNote: boolean;
	/** Whether it is pointed out for a moment, as one jumped to is. */
	highlighted: boolean;
	threadActivityAt?: ReadonlyMap<string, string>;
	/** Where its author's name leads. */
	authorLink?: AuthorLink;
	onOpenThread: (threadId: string) => void;
}) {
	// Unset until the first tap, so a screen that hovers never has a time shown twice.
	const [timeTapped, setTimeTapped] = useState(false);
	const { author } = message;
	if (author.kind === "routine_trigger") return null;

	// A tap is a touch screen's hover: it shows a follow-up's time, as hovering does.
	function toggleTimeOnTouch(event: MouseEvent) {
		if (startsGroup || !window.matchMedia(NO_HOVER).matches) return;
		if (event.target instanceof Element && event.target.closest("a, button")) return;
		setTimeTapped((shown) => !shown);
	}
	const agent = author.kind === "agent" ? author : undefined;
	const size = ROW[compact ? "compact" : "regular"];
	const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call");
	const segments = segmentsOf(message);
	const words = segments
		.flatMap((segment) => (segment.type === "text" && segment.text ? [segment.text] : []))
		.join("\n\n");
	const showsSomething =
		calls.length > 0 || segments.some((segment) => segment.type !== "text" || segment.text);
	// A reply with nothing settled yet is only its typing line, under the last message.
	if (message.status === "streaming" && !showsSomething) return null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a tap only puts on screen the time a screen reader already reads in the row, so a keyboard has nothing to reach.
		<article
			aria-label={`${author.name}, ${messageStatus(message, { queued })}`}
			data-message-id={message.id}
			onClick={toggleTimeOnTouch}
			className={cn(
				"group/message relative flex pb-0.5 transition-colors duration-700 motion-reduce:animate-none",
				highlighted ? "bg-primary/15" : "hover:bg-message-hover",
				size.row,
				startsGroup ? "pt-3.5" : "pt-0.5",
				!arrivedLive && "animate-rise",
			)}
			style={agent ? botColorVariables(agent.color) : undefined}
		>
			<span className="flex shrink-0 justify-center" style={{ width: size.face }}>
				{startsGroup ? (
					<span aria-hidden className="mt-0.5 flex">
						{author.kind === "agent" ? (
							<AgentAvatar color={author.color} face={author.face} size={size.face} />
						) : (
							<PersonAvatar person={author} size={size.face} />
						)}
					</span>
				) : (
					<span
						className={cn(
							"text-[11px] text-subtle-foreground tabular-nums leading-[22px] transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100",
							timeTapped ? "opacity-100" : "opacity-0",
						)}
					>
						<MessageTime createdAt={message.createdAt} />
					</span>
				)}
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start">
				{startsGroup && (
					<div className="flex items-center gap-2 pb-px">
						<AuthorName name={author.name} link={authorLink} />
						{agent && (
							<span className="rounded-[4px] bg-chip px-[5px] py-px font-semibold text-[10.5px] text-muted-foreground leading-[1.4]">
								Bot
							</span>
						)}
						<span className="text-subtle-foreground text-xs">
							<MessageTime createdAt={message.createdAt} />
						</span>
					</div>
				)}
				{agent && <ToolLine calls={calls} looks={looks} />}
				{segments.map((segment) => {
					if (segment.type === "collaboration") {
						const recipient = participants.find(
							(participant): participant is AgentParticipant =>
								participant.kind === "agent" && participant.id === segment.collaboration.agentId,
						);
						if (!agent || !recipient) return null;
						return (
							<CollaborationLine
								key={segment.key}
								initiator={agent}
								recipient={recipient}
								status={segment.collaboration.status}
								lastActivityAt={threadActivityAt?.get(segment.collaboration.threadId)}
								onOpen={() => onOpenThread(segment.collaboration.threadId)}
							/>
						);
					}
					if (segment.type === "tool_call") {
						const call = segment.toolCall;
						if (!agent) return null;
						return (
							<div key={segment.key} className="w-full max-w-[460px] pt-1.5 pb-1">
								<ToolApprovalCard
									call={call}
									agent={agent}
									threadId={message.threadId}
									podId={podId}
									canApprove={canApproveToolCalls}
									look={looks.get(splitToolKey(call.tool).handle)}
								/>
							</div>
						);
					}
					if (!segment.text) return null;
					return (
						<div
							key={segment.key}
							className={cn("min-w-0 self-stretch break-words text-body-foreground", size.words)}
						>
							{agent && arrivedLive ? (
								<div
									className="reply-grow"
									style={{ ["--reveal-duration" as string]: `${revealDurationMs(segment.text)}ms` }}
								>
									<div>
										<MessageMarkdown text={segment.text} mentionable={participants} />
									</div>
								</div>
							) : agent ? (
								<MessageMarkdown text={segment.text} mentionable={participants} />
							) : (
								<p className="m-0 whitespace-pre-wrap">
									{textWithMentions(segment.text, participants)}
								</p>
							)}
						</div>
					);
				})}
				{message.routineResultOf && (
					<RowNote className="text-subtle-foreground">
						<RoutineResultLink run={message.routineResultOf} onOpenThread={onOpenThread} />
					</RowNote>
				)}
				{message.status === "failed" && (
					<RowNote className="text-destructive-text">
						<span className="font-semibold">Reply failed.</span>
						{message.error && <span> {message.error}</span>}
					</RowNote>
				)}
				{message.status === "cancelled" && (
					<RowNote className="font-semibold text-subtle-foreground">Reply stopped</RowNote>
				)}
				{queuedNote && <RowNote className="text-subtle-foreground">Queued</RowNote>}
			</div>
			{words && (
				<div className="pointer-events-none absolute -top-3.5 right-5 z-10 flex rounded-[8px] border border-border-strong bg-panel p-0.5 opacity-0 shadow-popover transition-opacity group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 [@media(hover:none)]:sr-only">
					<CopyIconButton
						label="Copy text"
						text={words}
						side="top"
						className="h-7 w-[30px] rounded-tail text-soft-foreground hover:bg-border-strong [&_svg]:size-[15px]"
					/>
				</div>
			)}
		</article>
	);
}

/** An author's name, leading to their page when there is one. */
function AuthorName({ name, link }: { name: string; link: AuthorLink | undefined }) {
	const className = "font-semibold text-[15px] text-foreground";
	if (!link) return <span className={className}>{name}</span>;
	const linkClassName = cn(className, "rounded-[3px] hover:underline focus-ring");
	return link.kind === "agent" ? (
		<Link {...link.options} className={linkClassName}>
			{name}
		</Link>
	) : (
		<Link {...link.options} className={linkClassName}>
			{name}
		</Link>
	);
}

function MessageTime({ createdAt }: { createdAt: string }) {
	return (
		<Tooltip label={formatFullTimestamp(createdAt)} side="top">
			<time dateTime={createdAt} className="whitespace-nowrap hover:underline">
				{formatTime(createdAt)}
			</time>
		</Tooltip>
	);
}

/** A line under a message's words, such as why a reply failed. */
function RowNote({ className, children }: { className: string; children: ReactNode }) {
	return <p className={cn("m-0 pt-1 text-xs", className)}>{children}</p>;
}

/** Where a routine's result came from, opening the run with the work behind it. */
function RoutineResultLink({
	run,
	onOpenThread,
}: {
	run: RoutineResultOf;
	onOpenThread: (threadId: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpenThread(run.threadId)}
			className="focus-ring inline-flex items-center gap-0.5 rounded-sm font-medium transition-colors hover:text-soft-foreground"
		>
			From {run.routineName}
			<ChevronRight aria-hidden size={12} strokeWidth={2.4} />
		</button>
	);
}

/** How a collaboration's thread line labels where it stands, when it has settled or needs somebody. */
const COLLABORATION_TAG: Partial<Record<CollaborationPart["status"], string>> = {
	pending: "Needs approval",
	answered: "Done",
	failed: "Stopped",
};

/**
 * The collaboration a bot's message opened, as a thread under it: both bots'
 * faces, who it was with, when it last moved, and where it stands. The whole
 * line opens the thread beside the chat.
 */
function CollaborationLine({
	initiator,
	recipient,
	status,
	lastActivityAt,
	onOpen,
}: {
	initiator: AgentParticipant;
	recipient: AgentParticipant;
	status: CollaborationPart["status"];
	lastActivityAt?: string;
	onOpen: () => void;
}) {
	const tag = COLLABORATION_TAG[status];
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`Open Collaboration: ${initiator.name} and ${recipient.name}, ${tag ?? "Working"}`}
			className="focus-ring -ml-1.5 mt-[5px] flex max-w-full items-center gap-2 rounded-[8px] border border-transparent py-1 pr-2.5 pl-1.5 transition-colors hover:border-border-strong hover:bg-panel"
		>
			<span aria-hidden className="flex shrink-0">
				{[initiator, recipient].map((bot) => (
					<AgentAvatar
						key={bot.id}
						color={bot.color}
						face={bot.face}
						size={20}
						className="-mr-[7px] rounded-full shadow-[0_0_0_2px_var(--background)]"
					/>
				))}
			</span>
			<span className="truncate pl-2 font-semibold text-[13px] text-link">
				Collaboration with {recipient.name}
			</span>
			{lastActivityAt && (
				<span className="shrink-0 text-[12.5px] text-subtle-foreground">
					Last reply {formatTime(lastActivityAt)}
				</span>
			)}
			{tag ? (
				<span
					className={cn(
						"shrink-0 rounded-[5px] px-1.5 py-px font-semibold text-[11.5px]",
						status === "pending"
							? "bg-primary text-primary-foreground"
							: "bg-chip text-muted-foreground",
					)}
				>
					{tag}
				</span>
			) : (
				<span aria-hidden className="typing-dots typing-dots-small shrink-0 text-muted-foreground">
					<i />
					<i />
					<i />
				</span>
			)}
		</button>
	);
}

/** What started a routine run, at the top of the run's thread. */
function RoutineTriggerCard({ message }: { message: Message }) {
	if (message.author.kind !== "routine_trigger") return null;
	const source =
		message.author.triggerKind === "cron"
			? "Scheduled trigger"
			: message.author.triggerKind === "webhook"
				? "Webhook trigger"
				: "Manual run";
	return (
		<article aria-label={`${source} for ${message.author.routineName}`} className="px-5 pt-3.5">
			<div className="rounded-xl border border-border bg-list px-4 py-3">
				<div className="pb-1 font-semibold text-muted-foreground text-xs">
					{message.author.routineName} <span className="font-normal">{source}</span>
				</div>
				<p className="m-0 whitespace-pre-wrap break-words text-body-foreground text-md leading-relaxed">
					{message.content}
				</p>
			</div>
		</article>
	);
}

/** Where the chat moves on to a new day: a rule either side of "Today", "Yesterday" or the date. */
export function DaySeparator({ at }: { at: string }) {
	return (
		<div className="flex items-center gap-3 px-5 pt-2.5 pb-1.5">
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="font-semibold text-muted-foreground text-xs">{formatDay(new Date(at))}</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</div>
	);
}

/** An hour without a message starts a new group, with its author's face and name again. */
const LONG_QUIET_MS = 60 * 60_000;

/** Whether `at` is the first thing shown, or falls on a new day from `previousAt`, and so wants a day marker. */
export function startsNewDay(previousAt: string | undefined, at: string): boolean {
	return previousAt === undefined || !sameDate(new Date(previousAt), new Date(at));
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
	if (sameDate(date, today)) {
		return "Today";
	}
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (sameDate(date, yesterday)) {
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

function sameDay(left: { createdAt: string }, right: { createdAt: string }): boolean {
	return sameDate(new Date(left.createdAt), new Date(right.createdAt));
}

function sameDate(left: Date, right: Date): boolean {
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

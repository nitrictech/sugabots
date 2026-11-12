import { botColorVariables } from "@sugabots/avatars";
import {
	type CollaborationPart,
	type FilePart,
	type Message,
	type MessageReplyTo,
	messageAuthorName,
	type PersonParticipant,
	type RoutineResultOf,
	type ThreadParticipant,
	type ThreadType,
	type ToolCallPart,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, CornerUpLeft, MessageSquarePlus, Reply } from "lucide-react";
import { Fragment, type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";
import type { AuthorLink, PagedAuthor } from "@/lib/author-links.ts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { formatClockTime } from "@/lib/list-time.ts";
import { type ApprovalCapabilities, mayAnswer } from "@/lib/tool-approvals.ts";
import { BROWSER_TOOL_PREFIX, splitToolKey } from "@/lib/tool-names.ts";
import { AgentAvatar, WatchingAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ArtifactCards } from "./ArtifactCards.tsx";
import type { ActivityState } from "./ChatActivityRow.tsx";
import { LiveDesktopCard } from "./DesktopViewer.tsx";
import { type FileUrlOf, MessageFiles } from "./MessageFiles.tsx";
import { MessageMarkdown, writerOf } from "./MessageMarkdown.tsx";
import { AddReactionButton, MessageReactions, type Reacting } from "./MessageReactions.tsx";
import { groupMentionsBy } from "./mentions.tsx";
import { SideThreadLine, type SideThreadStatus } from "./SideThreadLine.tsx";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { ToolLine } from "./ToolLine.tsx";
import { anyoneTyping, type Typer, TypingIndicator } from "./TypingIndicator.tsx";
import {
	type AnsweringFace,
	formatDay,
	isTyping,
	sameDay,
	segmentsOf,
	showsNothingYet,
	startsGroup,
	startsNewDay,
	startsRun,
} from "./thread-layout.ts";

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
	members,
	threadType,
	dividers = true,
	onOpenThread,
	onOpenArtifact,
	onOpenDesktop,
	previews = true,
	podId,
	approvalCapabilities,
	compact = false,
	queued = NONE_QUEUED,
	sending = NONE_SENDING,
	peopleTyping = [],
	showsTyping = true,
	highlightedMessageId,
	threadActivityAt,
	authorLinkOf,
	onReply,
	onStartThread,
	threadLinesOf,
	inRoutineThread = false,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	answeringFace,
	viewerWriting = false,
}: {
	messages: Message[];
	/** The bot the thread is with; none in a pod's chat. */
	host?: AgentParticipant;
	isRunning: boolean;
	/**
	 * Everyone in the thread and the pod's bots and people: how a
	 * collaboration's other bot is found, and who a mention can name.
	 */
	participants: ThreadParticipant[];
	/** The pod's people, whom a person's `@here` or `@channel` would notify. */
	members: readonly PersonParticipant[];
	/** What kind of thread it is, which decides whether `@here` and `@channel` notify anyone. */
	threadType: ThreadType;
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
	/** Opens an artifact a reply wrote, from its card. Without it, no cards are drawn. */
	onOpenArtifact?: (artifactId: string) => void;
	/**
	 * Opens the bot's desktop from its screen, shown live in a reply while the
	 * reply uses the browser. Without it, no screen is shown.
	 */
	onOpenDesktop?: () => void;
	/**
	 * Whether replies show what they made: a card for each artifact, the
	 * desktop live. Off while one is open large beside the conversation.
	 */
	previews?: boolean;
	podId: string;
	/** What the person may decide of the approvals the thread raises. */
	approvalCapabilities?: ApprovalCapabilities;
	/** The sidebar's narrower thread: smaller faces and words. */
	compact?: boolean;
	/**
	 * People's messages that wait for the next reply, because one is still being
	 * written: `queuedBehindReply` over the whole conversation, not only these
	 * messages, since the reply may sit in an earlier run of them.
	 */
	queued?: ReadonlySet<string>;
	/**
	 * The user's messages still on their way to the API. Until it has them they
	 * cannot be replied or reacted to, as neither would find them there.
	 */
	sending?: ReadonlySet<string>;
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
	/** Starts a reply quoting the message, from its hover toolbar. Without it, none is offered. */
	onReply?: (message: Message) => void;
	/** In a pod's chat or a bot's channel: starts a thread from the message. */
	onStartThread?: (message: Message) => void;
	/** In a pod's chat or a bot's channel: the lines of the threads started from the message, drawn under it. */
	threadLinesOf?: (message: Message) => ReactNode;
	/**
	 * In a routine's own thread, where each result already sits under its run,
	 * so a result does not also say which routine it came from.
	 */
	inRoutineThread?: boolean;
	/** Goes to the message a reply quotes, from its quote. Without it, the quote is only read. */
	onJumpToMessage?: (messageId: string) => void;
	/**
	 * How the person reacts to messages: from the hover toolbar, and by clicking
	 * a reaction. Without it, reactions are only shown.
	 */
	reacting?: Reacting;
	/**
	 * Where a file attached to a message is served. A message still being sent
	 * shows its files without links, as the API can't serve them until it has it.
	 */
	fileUrlOf: (fileId: string) => string;
	/** The face that comes alive for the bot answering, as `findAnsweringFace` finds it; none unless given. */
	answeringFace?: AnsweringFace;
	/** Whether the viewer is writing a reply, which the answering face watches. */
	viewerWriting?: boolean;
}) {
	const lastMessage = messages.at(-1);
	// The turn has started but its reply has not been created yet.
	const replyPending = isRunning && lastMessage?.author.kind === "person";
	const lastReplyTyping =
		lastMessage !== undefined && lastMessage.author.kind === "agent" && isTyping(lastMessage);
	const looks = useConnectionLooks(podId);
	const fileNames = useMemo(() => fileNamesIn(messages), [messages]);
	const watchedWritten = useRepliesWatchedBeingWritten(messages);
	return (
		<div className="flex flex-col">
			{messages.map((message, index) => {
				const previous = messages[index - 1];
				const next = messages[index + 1];
				const divider = dividers && startsNewDay(previous?.createdAt, message.createdAt);
				const headsRun = startsRun(previous, message, dividers);
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
								startsGroup={headsRun}
								liveFace={
									message.id === answeringFace?.messageId
										? { botTyping: answeringFace.botTyping, viewerWriting }
										: undefined
								}
								participants={participants}
								members={members}
								threadType={threadType}
								looks={looks}
								fileNames={fileNames}
								podId={podId}
								approvalCapabilities={approvalCapabilities}
								compact={compact}
								arrivedLive={watchedWritten.has(message.id)}
								queued={queued.has(message.id)}
								sending={sending.has(message.id)}
								queuedNote={queuedNote}
								highlighted={message.id === highlightedMessageId}
								threadActivityAt={threadActivityAt}
								authorLink={authorLinkOf?.(message.author)}
								onReply={onReply}
								onStartThread={onStartThread}
								threadLines={threadLinesOf?.(message)}
								inRoutineThread={inRoutineThread}
								onJumpToMessage={onJumpToMessage}
								reacting={reacting}
								fileUrlOf={fileUrlOf}
								onOpenThread={onOpenThread}
								onOpenArtifact={onOpenArtifact}
								onOpenDesktop={onOpenDesktop}
								previews={previews}
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
				(replyPending && host ? (
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

interface AnsweringFaceState {
	botTyping: boolean;
	viewerWriting: boolean;
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
/** Where a file is served while its message is still being sent: nowhere yet. */
const notServedYet: FileUrlOf = () => undefined;

const NONE_SENDING: ReadonlySet<string> = new Set();

/** Screens that cannot hover, which is to say touch screens. */
const NO_HOVER = "(hover: none)";

/** How long a reply takes to grow to fit its words: longer for more of them, within bounds. */
const REVEAL_MS = { minimum: 400, maximum: 700, perCharacter: 0.5 };

function revealDurationMs(text: string): number {
	const scaled = REVEAL_MS.minimum + text.length * REVEAL_MS.perCharacter;
	return Math.round(Math.min(scaled, REVEAL_MS.maximum));
}

/** The names of the files attached in the thread, by id. */
function fileNamesIn(messages: readonly Message[]): ReadonlyMap<string, string> {
	return new Map(
		messages.flatMap((message) =>
			message.parts.flatMap((part) =>
				part.type === "file" ? [[part.id, part.name] as const] : [],
			),
		),
	);
}

/** How each part of a row is sized: the regular chat, or the sidebar's narrower thread. */
const ROW = {
	regular: { face: 36, row: "gap-3.5 px-5", words: "text-sm leading-normal" },
	compact: { face: 32, row: "gap-3 px-4.5", words: "text-sm leading-normal" },
} as const;

/**
 * One message as a row: at the head of a group its author's face, name and
 * time, then its words, any collaboration it opened as a thread line, and any
 * call somebody was asked to approve as its card. A reply has the message it
 * quotes over its author's name, and people's reactions under its words.
 * Hovered, it lifts slightly, shows its time beside a follow-up, and offers to
 * react to it, reply to it and copy its words.
 */
function MessageRow({
	message,
	startsGroup,
	participants,
	members,
	threadType,
	looks,
	fileNames,
	podId,
	approvalCapabilities,
	compact,
	arrivedLive,
	queued,
	sending,
	queuedNote,
	highlighted,
	threadActivityAt,
	authorLink,
	onReply,
	onStartThread,
	threadLines,
	inRoutineThread,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	onOpenThread,
	onOpenArtifact,
	onOpenDesktop,
	previews,
	liveFace,
}: {
	message: Message;
	/** Whether it heads its author's group, so it carries their face and name. */
	startsGroup: boolean;
	participants: ThreadParticipant[];
	members: readonly PersonParticipant[];
	threadType: ThreadType;
	looks: ReturnType<typeof useConnectionLooks>;
	/** The thread's files by id, for the tool line's calls that read them. */
	fileNames: ReadonlyMap<string, string>;
	podId: string;
	approvalCapabilities: ApprovalCapabilities | undefined;
	compact: boolean;
	/** Finished while the thread was open, so it arrives rather than simply being there. */
	arrivedLive: boolean;
	/** Whether this message waits for the next reply, because one is still being written. */
	queued: boolean;
	/** Whether it is still on its way to the API, so it cannot be replied or reacted to yet. */
	sending: boolean;
	/** Whether it ends a run of waiting messages, which says so once under the last of them. */
	queuedNote: boolean;
	/** Whether it is pointed out for a moment, as one jumped to is. */
	highlighted: boolean;
	threadActivityAt?: ReadonlyMap<string, string>;
	/** Where its author's name leads. */
	authorLink?: AuthorLink;
	onReply?: (message: Message) => void;
	onStartThread?: (message: Message) => void;
	threadLines?: ReactNode;
	inRoutineThread: boolean;
	onJumpToMessage?: (messageId: string) => void;
	reacting?: Reacting;
	/** Where a file attached to it is served. */
	fileUrlOf: (fileId: string) => string;
	onOpenThread: (threadId: string) => void;
	onOpenArtifact?: (artifactId: string) => void;
	onOpenDesktop?: () => void;
	previews: boolean;
	/** Given only where the face of the bot answering is drawn: whether it's typing, and whether the viewer is writing back. */
	liveFace?: AnsweringFaceState;
}) {
	// Unset until the first tap, so a screen that hovers never has a time shown twice.
	const [timeTapped, setTimeTapped] = useState(false);
	// The toolbar stays up while its emoji picker is open, as the pointer has left the row for it.
	const [picking, setPicking] = useState(false);
	const { author } = message;
	if (author.kind === "routine_trigger") return null;

	// A tap is a touch screen's hover: it shows a follow-up's time, as hovering does.
	function toggleTimeOnTouch(event: MouseEvent) {
		if (startsGroup || !window.matchMedia(NO_HOVER).matches) return;
		// A tap in a mention's card, drawn elsewhere on the page, still reaches here through React.
		if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
		if (event.target.closest("a, button, [role=button]")) return;
		setTimeTapped((shown) => !shown);
	}
	const agent = author.kind === "agent" ? author : undefined;
	const size = ROW[compact ? "compact" : "regular"];
	const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call");
	const files = message.parts.filter((part): part is FilePart => part.type === "file");
	const segments = segmentsOf(message);
	const mentionable = [...participants, ...groupMentionsBy(author, members, threadType)];
	const words = segments
		.flatMap((segment) => (segment.type === "text" && segment.text ? [segment.text] : []))
		.join("\n\n");
	// A reply with nothing settled yet is only its typing line, under the last message.
	if (showsNothingYet(message)) return null;
	const finished = message.status === "complete" && !sending;
	const replyable = onReply !== undefined && finished;
	const threadable = onStartThread !== undefined && finished;
	const reactable = reacting !== undefined && finished;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a tap only puts on screen the time a screen reader already reads in the row, so a keyboard has nothing to reach.
		<article
			aria-label={`${author.name}, ${messageStatus(message, { queued })}`}
			data-message-id={message.id}
			onClick={toggleTimeOnTouch}
			className={cn(
				"group/message relative flex pb-0.5 transition-colors duration-700 motion-reduce:animate-none",
				highlighted ? "bg-chip" : "hover:bg-message-hover",
				size.row,
				startsGroup ? "pt-3.5" : "pt-0.5",
				!arrivedLive && "animate-rise",
			)}
			style={agent ? botColorVariables(agent.color) : undefined}
		>
			{/* A reply's face lines up with its author's name, under the quote. */}
			<span
				className={cn("flex shrink-0 justify-center", message.replyTo && "pt-5.25")}
				style={{ width: size.face }}
			>
				{startsGroup ? (
					<span aria-hidden className="mt-0.5 flex">
						{author.kind === "agent" && liveFace ? (
							<WatchingAvatar
								bot={author}
								size={size.face}
								busy={liveFace.botTyping}
								watching={liveFace.viewerWriting}
							/>
						) : author.kind === "agent" ? (
							<AgentAvatar
								color={author.color}
								face={author.face}
								shape={author.shape}
								size={size.face}
							/>
						) : (
							<PersonAvatar person={author} size={size.face} />
						)}
					</span>
				) : (
					<span
						className={cn(
							"text-2xs text-subtle-foreground tabular-nums leading-5.5 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100",
							timeTapped ? "opacity-100" : "opacity-0",
						)}
					>
						<MessageTime createdAt={message.createdAt} />
					</span>
				)}
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start">
				{message.replyTo && <ReplyQuote replyTo={message.replyTo} onJump={onJumpToMessage} />}
				{startsGroup && (
					<div className="flex items-center gap-2 pb-px">
						<AuthorName name={author.name} link={authorLink} />
						{agent && (
							<span className="rounded bg-chip px-1.25 py-px font-semibold text-2xs text-muted-foreground leading-snug">
								Bot
							</span>
						)}
						<span className="text-subtle-foreground text-xs">
							<MessageTime createdAt={message.createdAt} />
						</span>
					</div>
				)}
				{agent && <ToolLine parts={message.parts} looks={looks} fileNames={fileNames} />}
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
							<div key={segment.key} className="w-full max-w-115 pt-1.5 pb-1">
								<ToolApprovalCard
									call={call}
									agent={agent}
									threadId={message.threadId}
									podId={podId}
									canApprove={mayAnswer(call, approvalCapabilities)}
									look={looks.get(splitToolKey(call.tool).handle)}
								/>
							</div>
						);
					}
					if (!segment.text) return null;
					const markdown = (
						<MessageMarkdown
							text={segment.text}
							mentionable={mentionable}
							writer={writerOf(author)}
						/>
					);
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
									<div>{markdown}</div>
								</div>
							) : (
								markdown
							)}
						</div>
					);
				})}
				{files.length > 0 && (
					<MessageFiles files={files} urlOf={sending ? notServedYet : fileUrlOf} />
				)}
				{agent &&
					previews &&
					onOpenDesktop &&
					message.status === "streaming" &&
					calls.some((call) => call.tool.startsWith(BROWSER_TOOL_PREFIX)) && (
						<div className="w-full max-w-115 pt-2 pb-1.5">
							<LiveDesktopCard
								threadId={message.threadId}
								agentId={agent.id}
								agentName={agent.name}
								onOpen={onOpenDesktop}
							/>
						</div>
					)}
				{agent && previews && onOpenArtifact && (
					<ArtifactCards
						parts={message.parts}
						podId={podId}
						botName={agent.name}
						onOpen={onOpenArtifact}
						className="pt-2"
					/>
				)}
				{threadLines}
				<MessageReactions message={message} reacting={reacting} addable={finished} />
				{message.routineResultOf && !inRoutineThread && (
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
			{(words || replyable || threadable || reactable) && (
				<div
					className={cn(
						"absolute -top-3.5 right-5 z-10 flex rounded-md border border-border-strong bg-panel p-0.5 shadow-popover transition-opacity group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 [@media(hover:none)]:sr-only",
						picking ? "opacity-100" : "pointer-events-none opacity-0",
					)}
				>
					{reactable && (
						<AddReactionButton
							message={message}
							reacting={reacting}
							onOpenChange={setPicking}
							className={TOOLBAR_BUTTON}
						/>
					)}
					{replyable && (
						<IconButton
							label="Reply"
							side="top"
							onClick={() => onReply(message)}
							className={TOOLBAR_BUTTON}
						>
							<Reply aria-hidden />
						</IconButton>
					)}
					{threadable && (
						<IconButton
							label="Start a thread"
							side="top"
							onClick={() => onStartThread(message)}
							className={TOOLBAR_BUTTON}
						>
							<MessageSquarePlus aria-hidden />
						</IconButton>
					)}
					{words && (
						<CopyIconButton label="Copy text" text={words} side="top" className={TOOLBAR_BUTTON} />
					)}
				</div>
			)}
		</article>
	);
}

const TOOLBAR_BUTTON =
	"h-7 w-7.5 rounded-tail text-soft-foreground hover:bg-border-strong [&_svg]:size-3.75";

/**
 * Over a reply, whose message it answers and that message's first line. With
 * `onJump` it is a button going to that message.
 */
function ReplyQuote({
	replyTo,
	onJump,
}: {
	replyTo: MessageReplyTo;
	onJump?: (messageId: string) => void;
}) {
	const name = messageAuthorName(replyTo.author);
	const quote = (
		<>
			<CornerUpLeft aria-hidden size={13} strokeWidth={2.2} className="shrink-0" />
			<span className="shrink-0">Replying to</span>
			<span className="shrink-0 font-semibold text-soft-foreground">{name}</span>
			<span className="ml-0.5 min-w-0 truncate">{replyTo.preview}</span>
		</>
	);
	// 21px tall, which the reply's face is moved down by to line up with the name.
	const className =
		"-ml-1 flex h-5.25 max-w-full items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground leading-4.75";
	if (!onJump) return <p className={cn("m-0", className)}>{quote}</p>;
	return (
		<button
			type="button"
			aria-label={`Replying to ${name}: ${replyTo.preview}`}
			onClick={() => onJump(replyTo.id)}
			className={cn("focus-ring transition-colors hover:text-foreground", className)}
		>
			{quote}
		</button>
	);
}

/** An author's name, leading to their page when there is one. */
function AuthorName({ name, link }: { name: string; link: AuthorLink | undefined }) {
	const className = "font-semibold text-sm text-foreground";
	if (!link) return <span className={className}>{name}</span>;
	const linkClassName = cn(className, "rounded hover:underline focus-ring");
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

/** Where a collaboration stands, as its line here and its row in Inbox both say it. */
export function collaborationActivityState(status: CollaborationPart["status"]): ActivityState {
	switch (status) {
		case "waiting":
		case "pending":
			return "running";
		case "answered":
			return "done";
		case "failed":
			return "failed";
	}
}

/** How a collaboration's line shows where it stands. */
const COLLABORATION_LINE_STATUS: Record<ActivityState, SideThreadStatus> = {
	running: "working",
	done: { text: "Done", done: true },
	failed: { text: "Stopped" },
};

/**
 * The collaboration a bot's message opened, hanging off it: both bots' faces,
 * who it asked, where it stands, and when it last moved.
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
	return (
		<SideThreadLine
			faces={[initiator, recipient]}
			label={`Asked ${recipient.name}`}
			description={`Open Collaboration: ${initiator.name} and ${recipient.name}`}
			lastActivityAt={lastActivityAt}
			status={COLLABORATION_LINE_STATUS[collaborationActivityState(status)]}
			onOpen={onOpen}
		/>
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
				: message.author.triggerKind === "github"
					? "Repository trigger"
					: "Manual run";
	return (
		<article aria-label={`${source} for ${message.author.routineName}`} className="px-5 pt-3.5">
			<div className="rounded-xl border border-border bg-list px-4 py-3">
				<div className="pb-1 font-semibold text-muted-foreground text-xs">
					{message.author.routineName} <span className="font-normal">{source}</span>
				</div>
				<p className="m-0 whitespace-pre-wrap break-words text-body-foreground text-xs leading-relaxed">
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

/** For example "Today at 4:58:34 PM", "Aug 5 at 3:46:46 PM", or "Aug 5, 2025 at 3:46:46 PM". */
export function formatFullTimestamp(createdAt: string): string {
	const date = new Date(createdAt);
	const time = new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	}).format(date);
	return `${formatDay(date)} at ${time}`;
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

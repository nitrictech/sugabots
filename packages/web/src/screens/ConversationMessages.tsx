import { botColorVariables } from "@sugabots/avatars";
import {
	type AutomationResultOf,
	type CollaborationPart,
	type ConversationKind,
	type FilePart,
	type Message,
	type MessageReplyTo,
	messageAuthorName,
	type Participant,
	type PersonParticipant,
	type ToolCallPart,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, CornerUpLeft, Reply, SquareArrowOutUpRight } from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	type MouseEvent,
	type ReactNode,
	useMemo,
	useRef,
	useState,
} from "react";
import { type ApprovalCapabilities, mayAnswer } from "@/lib/approvals.ts";
import type { AuthorLink, PagedAuthor } from "@/lib/author-links.ts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { useConversationEvents } from "@/lib/conversation-events.ts";
import { useConversation } from "@/lib/conversations.ts";
import { formatClockTime } from "@/lib/list-time.ts";
import { BROWSER_TOOL_PREFIX, splitToolKey } from "@/lib/tool-names.ts";
import { BotAvatar, WatchingAvatar } from "@/shell/Bot.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import type { ActivityState } from "./ChatActivityRow.tsx";
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
} from "./conversation-layout.ts";
import { LiveDesktopCard } from "./DesktopViewer.tsx";
import { FileCards } from "./FileCards.tsx";
import { type FileUrlOf, MessageFiles } from "./MessageFiles.tsx";
import { MessageMarkdown, writerOf } from "./MessageMarkdown.tsx";
import { AddReactionButton, MessageReactions, type Reacting } from "./MessageReactions.tsx";
import { groupMentionsBy } from "./mentions.tsx";
import { SideConversationLine, type SideConversationStatus } from "./SideConversationLine.tsx";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { ToolLine, WorkedFor } from "./ToolLine.tsx";
import { anyoneTyping, type Typer, TypingIndicator } from "./TypingIndicator.tsx";

type BotParticipant = Extract<Participant, { kind: "bot" }>;

/*
 * A message is drawn as a row: its author's face and name at the head of a
 * group, then its parts in order. Text is its words, and each collaboration is
 * a side line opening the conversation it started. So a bot that writes,
 * asks another bot, and writes again shows as words, a side line, and
 * words, in the order it happened.
 *
 * A reply's text is drawn once it is settled, never as it streams. What the
 * bot writes on the way is often the lead-in to a tool call ("Let me find
 * the cycle:"), and that cannot be told until the call arrives, so text drawn
 * live would show words and then take them back. Text is settled when the
 * reply finishes or when something follows it: text before a collaboration is
 * shown while the collaboration runs, so the conversation reads in the order it
 * happened. While the turn runs, one line says the bot is typing.
 *
 * Tool calls are not drawn as parts at all. They belong to the turn rather than
 * to the transcript: the tool line above a reply is the way to what they did.
 * What the bot said just before a call is narration and goes with them. The
 * exception is a write somebody was asked to approve: it stopped the reply,
 * and whoever answered it may want to read again what they agreed to, so it
 * stays in the conversation as its card, waiting or answered, mid-turn included.
 */

export function ConversationMessages({
	messages,
	host,
	isRunning,
	participants,
	members,
	conversationKind,
	dividers = true,
	onOpenItem,
	onOpenFile,
	onOpenDesktop,
	previews = true,
	approvalCapabilities,
	compact = false,
	queued = NONE_QUEUED,
	sending = NONE_SENDING,
	peopleTyping = [],
	showsTyping = true,
	highlightedMessageId,
	itemActivityAt,
	authorLinkOf,
	onReply,
	sideLinesOf,
	inAutomationFeed = false,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	answeringFace,
	viewerWriting = false,
	viewerId,
	look = "rows",
	nameColorsFor,
}: {
	messages: Message[];
	/** The bot the task is with; none in a channel. */
	host?: BotParticipant;
	isRunning: boolean;
	/**
	 * Everyone in the conversation and the channel's bots and people: how a
	 * collaboration's other bot is found, and who a mention can name.
	 */
	participants: Participant[];
	/** The channel's people, whom a person's `@here` or `@channel` would notify. */
	members: readonly PersonParticipant[];
	/** What kind of conversation it is, which decides whether `@here` and `@channel` notify anyone. */
	conversationKind: ConversationKind;
	/**
	 * Day markers between messages. Off where the caller places its own, as the
	 * chat does between these messages and its activity rows.
	 */
	dividers?: boolean;
	/**
	 * Opens a collaboration from its line, or the run an automation's result came
	 * from, in the sidebar beside this conversation.
	 */
	onOpenItem: (conversationId: string) => void;
	/** Opens a file a reply wrote, from its card. Without it, no cards are drawn. */
	onOpenFile?: (fileId: string) => void;
	/**
	 * Opens the bot's desktop from its screen, shown live in a reply while the
	 * reply uses the browser. Without it, no screen is shown.
	 */
	onOpenDesktop?: () => void;
	/**
	 * Whether replies show what they made: a card for each file, the
	 * desktop live. Off while one is open large beside the conversation.
	 */
	previews?: boolean;

	/** What the person may decide of the approvals the conversation raises. */
	approvalCapabilities?: ApprovalCapabilities;
	/** The sidebar's narrower conversation: smaller faces and words. */
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
	 * Other people typing in the conversation. They join a bot typing the last reply,
	 * or are shown after the last message on their own.
	 */
	peopleTyping?: readonly PersonParticipant[];
	/** Off where the caller says who is typing itself, as the chat does under its composer. */
	showsTyping?: boolean;
	/** A message pointed out for a moment, as one jumped to is. */
	highlightedMessageId?: string;
	/** When each collaboration a message opened last had something in it, by its conversation's id. */
	itemActivityAt?: ReadonlyMap<string, string>;
	/** Where an author's name leads. Names are plain text without it. */
	authorLinkOf?: (author: PagedAuthor) => AuthorLink | undefined;
	/** Starts a reply quoting the message, from its hover toolbar. Without it, none is offered. */
	onReply?: (message: Message) => void;
	/** The lines of the tasks a bot's message started, drawn under it. */
	sideLinesOf?: (message: Message) => ReactNode;
	/**
	 * In an automation's feed, where each result already sits under its run,
	 * so a result does not also say which automation it came from.
	 */
	inAutomationFeed?: boolean;
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
	/** The person reading, whose own messages are drawn on the right. Without it, everyone's are drawn alike. */
	viewerId?: string;
	/**
	 * How the messages are drawn: as rows, as direct messages and channels have
	 * them, or as a bot's task, with bots' words open on the page and people's
	 * in bubbles.
	 */
	look?: MessageLook;
	/**
	 * The conversation people's name colours are picked for, so a person keeps
	 * theirs on a message brought in from elsewhere. By default, each message's
	 * own conversation.
	 */
	nameColorsFor?: string;
}) {
	const lastMessage = messages.at(-1);
	// The turn has started but its reply has not been created yet.
	const replyPending = isRunning && lastMessage?.author.kind === "person";
	const lastReplyTyping =
		lastMessage !== undefined && lastMessage.author.kind === "bot" && isTyping(lastMessage);
	const speakers = useMemo(() => speakersIn(messages), [messages]);
	const looks = useConnectionLooks(speakers);
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
						{message.author.kind === "automation_trigger" ? (
							<AutomationTriggerCard message={message} />
						) : (
							<Row
								look={look}
								message={message}
								startsGroup={headsRun}
								viewerId={viewerId}
								hostId={host?.id}
								nameColorsFor={nameColorsFor}
								liveFace={
									message.id === answeringFace?.messageId
										? { botTyping: answeringFace.botTyping, viewerWriting }
										: undefined
								}
								participants={participants}
								members={members}
								conversationKind={conversationKind}
								looks={looks}
								fileNames={fileNames}
								approvalCapabilities={approvalCapabilities}
								compact={compact}
								arrivedLive={watchedWritten.has(message.id)}
								queued={queued.has(message.id)}
								sending={sending.has(message.id)}
								queuedNote={queuedNote}
								highlighted={message.id === highlightedMessageId}
								itemActivityAt={itemActivityAt}
								authorLink={authorLinkOf?.(message.author)}
								onReply={onReply}
								sideLines={sideLinesOf?.(message)}
								inAutomationFeed={inAutomationFeed}
								onJumpToMessage={onJumpToMessage}
								reacting={reacting}
								fileUrlOf={fileUrlOf}
								onOpenItem={onOpenItem}
								onOpenFile={onOpenFile}
								onOpenDesktop={onOpenDesktop}
								previews={previews}
							/>
						)}
						{showsTyping && message.author.kind === "bot" && isTyping(message) && (
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
	if (last?.author.kind === "bot" && isTyping(last)) return [last.author, ...peopleTyping];
	return [...peopleTyping];
}

interface AnsweringFaceState {
	botTyping: boolean;
	viewerWriting: boolean;
}

/**
 * The ids of replies this conversation has seen while they were still being written.
 * One that is finished and in here arrived while someone watched, as opposed
 * to being loaded with the conversation's history. Only ever added to, so a reply
 * keeps its arrival for as long as the conversation stays open.
 */
function useRepliesWatchedBeingWritten(messages: readonly Message[]): ReadonlySet<string> {
	const seen = useRef(new Set<string>());
	for (const message of messages) {
		if (message.status === "streaming") seen.current.add(message.id);
	}
	return seen.current;
}

/** How a conversation draws its messages; see `ConversationMessages`' `look`. */
export type MessageLook = "rows" | "task";

/** One message, drawn in the conversation's look. */
function Row({
	look,
	viewerId,
	hostId,
	nameColorsFor,
	...row
}: Parameters<typeof MessageRow>[0] & {
	look: MessageLook;
	viewerId: string | undefined;
	hostId: string | undefined;
	nameColorsFor: string | undefined;
}) {
	return look === "task" ? (
		<TaskMessage {...row} viewerId={viewerId} hostId={hostId} nameColorsFor={nameColorsFor} />
	) : (
		<MessageRow {...row} />
	);
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

/** The names of the files attached in the conversation, by id. */
function fileNamesIn(messages: readonly Message[]): ReadonlyMap<string, string> {
	return new Map(
		messages.flatMap((message) =>
			message.parts.flatMap((part) =>
				part.type === "file" ? [[part.id, part.name] as const] : [],
			),
		),
	);
}

/** How big a face is beside its author's name: a bot's over its words, a person's in their bubble. */
const FACE_PX = { bot: 16, person: 16 } as const;

/** How the words of a message are set: the regular chat, or the sidebar's narrower conversation. */
const WORDS = {
	regular: "text-sm leading-relaxed",
	compact: "text-sm leading-normal",
} as const;

/**
 * Which way a message is drawn: a bot's words open on the page under its
 * name, someone else's in an outlined bubble beside their face, and the
 * viewer's own in a filled bubble on the right.
 */
type RowSide = "bot" | "person" | "mine";

/**
 * One message as a bot's task draws it. A bot's carries its face, name and
 * time at the head of a group, then its work line, words, any collaboration it
 * opened as a card, and any call somebody was asked to approve as its card,
 * with a row of actions under it. A person's words sit in a bubble: someone else's on the
 * left, headed by their name, the viewer's own on the right over its time. A reply
 * quotes the message it answers above its words, and people's reactions sit
 * under them.
 */
function TaskMessage({
	message,
	startsGroup,
	viewerId,
	hostId,
	nameColorsFor,
	participants,
	members,
	conversationKind,
	looks,
	fileNames,
	approvalCapabilities,
	compact,
	arrivedLive,
	queued,
	sending,
	queuedNote,
	highlighted,
	authorLink,
	onReply,
	sideLines,
	inAutomationFeed,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	onOpenItem,
	onOpenFile,
	onOpenDesktop,
	previews,
	liveFace,
}: {
	message: Message;
	/** Whether it heads its author's group, so it carries their face and name. */
	startsGroup: boolean;
	/** The person reading, whose own messages are drawn on the right. */
	viewerId: string | undefined;
	/** The bot the chat is with, whose face is in the chat's header rather than over its messages. */
	hostId: string | undefined;
	/** The conversation people's name colours are picked for; each message's own without it. */
	nameColorsFor: string | undefined;
	participants: Participant[];
	members: readonly PersonParticipant[];
	conversationKind: ConversationKind;
	looks: ReturnType<typeof useConnectionLooks>;
	/** The conversation's files by id, for the work line's calls that read them. */
	fileNames: ReadonlyMap<string, string>;
	approvalCapabilities: ApprovalCapabilities | undefined;
	compact: boolean;
	/** Finished while the conversation was open, so it arrives rather than simply being there. */
	arrivedLive: boolean;
	/** Whether this message waits for the next reply, because one is still being written. */
	queued: boolean;
	/** Whether it is still on its way to the API, so it cannot be replied or reacted to yet. */
	sending: boolean;
	/** Whether it ends a run of waiting messages, which says so once under the last of them. */
	queuedNote: boolean;
	/** Whether it is pointed out for a moment, as one jumped to is. */
	highlighted: boolean;
	itemActivityAt?: ReadonlyMap<string, string>;
	/** Where its author's name leads. */
	authorLink?: AuthorLink;
	onReply?: (message: Message) => void;
	sideLines?: ReactNode;
	inAutomationFeed: boolean;
	onJumpToMessage?: (messageId: string) => void;
	reacting?: Reacting;
	/** Where a file attached to it is served. */
	fileUrlOf: (fileId: string) => string;
	onOpenItem: (conversationId: string) => void;
	onOpenFile?: (fileId: string) => void;
	onOpenDesktop?: () => void;
	previews: boolean;
	/** Given only where the face of the bot answering is drawn: whether it's typing, and whether the viewer is writing back. */
	liveFace?: AnsweringFaceState;
}) {
	// The actions stay up while their emoji picker is open, as the pointer has left the row for it.
	const [picking, setPicking] = useState(false);
	const { author } = message;
	if (author.kind === "automation_trigger") return null;
	// A reply with nothing settled yet is only its typing line, under the last message.
	if (showsNothingYet(message)) return null;

	const bot = author.kind === "bot" ? author : undefined;
	const side: RowSide = bot ? "bot" : author.id === viewerId ? "mine" : "person";
	const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call");
	const files = message.parts.filter((part): part is FilePart => part.type === "file");
	const segments = segmentsOf(message);
	const mentionable = [...participants, ...groupMentionsBy(author, members, conversationKind)];
	const words = segments
		.flatMap((segment) => (segment.type === "text" && segment.text ? [segment.text] : []))
		.join("\n\n");
	const finished = message.status === "complete" && !sending;
	const wordsClassName = cn(
		"min-w-0 break-words text-body-foreground",
		WORDS[compact ? "compact" : "regular"],
	);
	const quote = message.replyTo && (
		<ReplyQuote
			replyTo={message.replyTo}
			onJump={onJumpToMessage}
			tone={quoteToneOf(message.replyTo.author, nameColorsFor ?? message.conversationId)}
		/>
	);

	const parts = segments.map((segment) => {
		if (segment.type === "collaboration") {
			const recipient = participants.find(
				(participant): participant is BotParticipant =>
					participant.kind === "bot" && participant.id === segment.collaboration.botId,
			);
			if (!bot || !recipient) return null;
			return (
				<CollaborationCard
					key={segment.key}
					initiator={bot}
					recipient={recipient}
					conversationId={segment.collaboration.conversationId}
					status={segment.collaboration.status}
					participants={participants}
					onOpen={() => onOpenItem(segment.collaboration.conversationId)}
				/>
			);
		}
		if (segment.type === "tool_call") {
			const call = segment.toolCall;
			if (!bot) return null;
			return (
				<div key={segment.key} className="w-full max-w-115 pt-1.5 pb-1">
					<ToolApprovalCard
						call={call}
						bot={bot}
						conversationId={message.conversationId}
						canApprove={mayAnswer(call, bot.id, approvalCapabilities)}
						look={looks.get(splitToolKey(call.tool).handle)}
					/>
				</div>
			);
		}
		if (!segment.text) return null;
		const markdown = (
			<MessageMarkdown text={segment.text} mentionable={mentionable} writer={writerOf(author)} />
		);
		return (
			<div key={segment.key} className={cn(wordsClassName, "self-stretch")}>
				{bot && arrivedLive ? (
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
	});

	const actions = (
		<MessageActions
			message={message}
			words={words}
			onReply={finished ? onReply : undefined}
			reacting={finished ? reacting : undefined}
			onPickingChange={setPicking}
		/>
	);
	const notes = (
		<>
			{message.automationResultOf && !inAutomationFeed && (
				<RowNote className="text-subtle-foreground">
					<AutomationResultLink run={message.automationResultOf} onOpenItem={onOpenItem} />
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
		</>
	);
	const fileList = files.length > 0 && (
		<MessageFiles files={files} urlOf={sending ? notServedYet : fileUrlOf} />
	);
	const reactions = (
		<MessageReactions message={message} reacting={reacting} addable={finished} filled />
	);
	// Between a message's reactions and what can be done to it, once it has any.
	const divider = (message.reactions?.length ?? 0) > 0 && (
		<span aria-hidden className="mx-1.5 h-3.5 w-px bg-border-strong" />
	);
	// The chat's own bot is named in its header, so its messages carry no head of their own.
	const headed = startsGroup && !(bot !== undefined && bot.id === hostId);
	// Shown with the actions on messages without a head, which would carry it.
	const followUpTime = !headed && (
		<span className="px-1 text-2xs text-subtle-foreground tabular-nums">
			<MessageTime createdAt={message.createdAt} />
		</span>
	);

	return (
		<article
			aria-label={`${author.name}, ${messageStatus(message, { queued })}`}
			data-message-id={message.id}
			className={cn(
				"group/message relative flex flex-col px-5 pb-0.5 transition-colors duration-700 motion-reduce:animate-none",
				side === "mine" && "items-end",
				// Pointed out, a bot's words are lifted on a soft card; a bubble rings itself instead.
				highlighted && side === "bot" && "rounded-xl bg-chip",
				startsGroup ? "pt-6" : "pt-2",
				!arrivedLive && "animate-rise",
			)}
			style={bot ? botColorVariables(bot.color) : undefined}
		>
			{side === "bot" && bot ? (
				<>
					{headed && (
						<header className="flex items-center gap-2 pb-2 text-subtle-foreground text-xs">
							<span aria-hidden className="flex">
								{liveFace ? (
									<WatchingAvatar
										bot={bot}
										size={FACE_PX.bot}
										busy={liveFace.botTyping}
										watching={liveFace.viewerWriting}
									/>
								) : (
									<BotAvatar
										color={bot.color}
										face={bot.face}
										shape={bot.shape}
										size={FACE_PX.bot}
									/>
								)}
							</span>
							<AuthorName name={author.name} link={authorLink} />
							<MessageTime createdAt={message.createdAt} />
						</header>
					)}
					<div className="flex min-w-0 flex-col items-start gap-1.5">
						{quote}
						<WorkedFor message={message} looks={looks} fileNames={fileNames} className="mb-1.5" />
						{parts}
						{fileList}
						{previews &&
							onOpenDesktop &&
							message.status === "streaming" &&
							calls.some((call) => call.tool.startsWith(BROWSER_TOOL_PREFIX)) && (
								<div className="w-full max-w-115 pt-1">
									<LiveDesktopCard
										conversationId={message.conversationId}
										botId={bot.id}
										botName={bot.name}
										onOpen={onOpenDesktop}
									/>
								</div>
							)}
						{previews && onOpenFile && (
							<FileCards
								parts={message.parts}
								botName={bot.name}
								onOpen={onOpenFile}
								className="pt-1"
							/>
						)}
						{sideLines}
					</div>
					{/* Its reactions, then what can be done to it, shown while it is pointed at. */}
					<div className="flex min-h-7 flex-wrap items-center gap-1 pt-1">
						{reactions}
						{finished && (
							<div
								className={cn(
									"flex items-center gap-0.5 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100",
									(message.reactions?.length ?? 0) === 0 && "-ml-1.5",
									picking ? "opacity-100" : "opacity-0",
								)}
							>
								{(message.reactions?.length ?? 0) > 0 && (
									<span aria-hidden className="mr-1.5 ml-1 h-3.5 w-px bg-border-strong" />
								)}
								{actions}
								{followUpTime}
							</div>
						)}
					</div>
					{notes}
				</>
			) : (
				<div
					className={cn(
						"flex min-w-0 max-w-4/5 gap-2.5 max-md:max-w-11/12",
						side === "mine" && "flex-row-reverse",
					)}
				>
					<div
						className={cn(
							"flex min-w-0 flex-col gap-1",
							side === "mine" ? "items-end" : "items-start",
						)}
					>
						{quote}
						<div
							className={cn("relative flex items-end gap-1", side === "mine" && "flex-row-reverse")}
						>
							{words && (
								<div
									className={cn(
										"min-w-0 rounded-bubble px-3.5 py-2 transition-shadow duration-700",
										highlighted && "ring-2 ring-ring ring-offset-2 ring-offset-background",
										side === "mine"
											? "rounded-br-tail bubble-mine"
											: "bg-zinc-100 dark:bg-zinc-900",
										side === "person" && startsGroup && "rounded-tl-tail",
									)}
								>
									{/* Someone else's face and name head their bubble. */}
									{startsGroup && side === "person" && (
										<header className="flex items-center gap-1.5 pb-0.5 text-xs">
											{author.kind === "person" && (
												<span aria-hidden className="flex">
													<PersonAvatar person={author} size={FACE_PX.person} />
												</span>
											)}
											<AuthorName
												name={author.name}
												link={authorLink}
												colorClassName={
													nameColorIn(nameColorsFor ?? message.conversationId, author.id).text
												}
											/>
										</header>
									)}
									{parts}
								</div>
							)}
						</div>
						{fileList}
						{sideLines}
						{/*
						 * Under it, its reactions, and beside them what can be done to it and its
						 * time, shown while it is pointed at. Under your own, the reactions keep to
						 * the bubble's edge and the rest opens out to their left.
						 */}
						<div
							className={cn(
								"flex min-h-7 flex-wrap items-center gap-1",
								side === "mine" && "flex-row-reverse",
							)}
						>
							{reactions}
							<div
								className={cn(
									"flex items-center gap-0.5 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100",
									(message.reactions?.length ?? 0) === 0 &&
										(side === "mine" ? "-mr-1.5" : "-ml-1.5"),
									picking ? "opacity-100" : "opacity-0",
								)}
							>
								{side === "person" && divider}
								{actions}
								<span className="px-1.5 text-2xs text-subtle-foreground tabular-nums">
									<MessageTime createdAt={message.createdAt} />
								</span>
								{side === "mine" && divider}
							</div>
						</div>
						{notes}
					</div>
				</div>
			)}
		</article>
	);
}

/**
 * What can be done to a message: copy its words, react to it and reply to
 * it, each offered only where the caller allows it.
 */
function MessageActions({
	message,
	words,
	onReply,
	reacting,
	onPickingChange,
}: {
	message: Message;
	words: string;
	onReply: ((message: Message) => void) | undefined;
	reacting: Reacting | undefined;
	/** Whether the emoji picker is open, as the actions stay up while it is. */
	onPickingChange: (open: boolean) => void;
}) {
	return (
		<>
			{words && (
				<CopyIconButton label="Copy text" text={words} side="top" className={ACTION_BUTTON} />
			)}
			{reacting && (
				<AddReactionButton
					message={message}
					reacting={reacting}
					align="start"
					onOpenChange={onPickingChange}
					className={ACTION_BUTTON}
				/>
			)}
			{onReply && (
				<IconButton
					label="Reply"
					side="top"
					onClick={() => onReply(message)}
					className={ACTION_BUTTON}
				>
					<Reply aria-hidden />
				</IconButton>
			)}
		</>
	);
}

const ACTION_BUTTON =
	"size-7 rounded-md text-subtle-foreground hover:bg-chip hover:text-foreground [&_svg]:size-3.75";

/** How a name is coloured, with the variables a bot's colour needs. */
interface QuoteTone {
	text: string;
	style?: CSSProperties;
}

/** The colour of a quote of `author`'s message: their name's colour in this chat, or a bot's own colour. */
function quoteToneOf(author: MessageReplyTo["author"], chatId: string): QuoteTone {
	if (author.kind === "person") return nameColorIn(chatId, author.id);
	if (author.kind === "bot") {
		return {
			text: "text-bot-text",
			style: botColorVariables(author.color),
		};
	}
	return { text: "text-muted-foreground" };
}

/**
 * Above a reply, outside its bubble, the message it answers on one line: a
 * reply arrow, its author's name in their colour, and the start of what they
 * said. With `onJump` it is a button going to that message.
 */
function ReplyQuote({
	replyTo,
	onJump,
	tone,
}: {
	replyTo: MessageReplyTo;
	onJump?: (messageId: string) => void;
	tone: QuoteTone;
}) {
	const name = messageAuthorName(replyTo.author);
	const quote = (
		<>
			<CornerUpLeft
				aria-hidden
				size={13}
				strokeWidth={2}
				className="shrink-0 text-subtle-foreground"
			/>
			<span className={cn("shrink-0 font-medium", tone.text)}>{name}</span>
			<span className="min-w-0 truncate text-subtle-foreground">{replyTo.preview}</span>
		</>
	);
	const className = cn(
		"flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left text-xs leading-snug",
	);
	if (!onJump) {
		return (
			<p className={cn("m-0", className)} style={tone.style}>
				{quote}
			</p>
		);
	}
	return (
		<button
			type="button"
			aria-label={`Replying to ${name}: ${replyTo.preview}`}
			onClick={() => onJump(replyTo.id)}
			className={cn(
				"focus-ring rounded-r-sm opacity-80 transition-opacity hover:opacity-100",
				className,
			)}
			style={tone.style}
		>
			{quote}
		</button>
	);
}

/** An author's name, leading to their page when there is one. */
function AuthorName({
	name,
	link,
	colorClassName,
}: {
	name: string;
	link: AuthorLink | undefined;
	/** The colour it is set in, as a group chat tells its people apart; muted without one. */
	colorClassName?: string;
}) {
	const className = cn(
		"font-medium text-xs",
		colorClassName ?? "text-muted-foreground hover:text-foreground",
	);
	if (!link) {
		return <span className={className}>{name}</span>;
	}
	const linkClassName = cn(className, "rounded hover:underline focus-ring");
	return link.kind === "bot" ? (
		<Link {...link.options} className={linkClassName}>
			{name}
		</Link>
	) : (
		<Link {...link.options} className={linkClassName}>
			{name}
		</Link>
	);
}

/** The colours names are set in, each made to read in both themes. */
const NAME_COLORS = [
	{ text: "text-pink-700 dark:text-pink-400" },
	{ text: "text-blue-700 dark:text-blue-400" },
	{ text: "text-emerald-700 dark:text-emerald-400" },
	{ text: "text-amber-700 dark:text-amber-400" },
	{ text: "text-violet-700 dark:text-violet-400" },
	{ text: "text-red-700 dark:text-red-400" },
	{ text: "text-cyan-700 dark:text-cyan-400" },
	{ text: "text-lime-700 dark:text-lime-400" },
	{ text: "text-orange-700 dark:text-orange-400" },
	{ text: "text-fuchsia-700 dark:text-fuchsia-400" },
] as const;

/**
 * The colour a person's name is set in within one chat: the same there every
 * time, but picked again in each chat, as a messaging app's groups do.
 */
function nameColorIn(conversationId: string, personId: string): QuoteTone {
	let hash = 0;
	for (const character of `${conversationId}:${personId}`) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	}
	return NAME_COLORS[hash % NAME_COLORS.length] ?? NAME_COLORS[0];
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

/** How each part of a row is sized: the regular chat, or the sidebar's narrower conversation. */
const ROW = {
	regular: { face: 36, row: "gap-3.5 px-5", words: "text-sm leading-normal" },
	compact: { face: 32, row: "gap-3 px-4.5", words: "text-sm leading-normal" },
} as const;

/**
 * One message as a row, as direct messages and channels draw them: at the head of a group its author's face, name and
 * time, then its words, any collaboration it opened as a side line, and any
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
	conversationKind,
	looks,
	fileNames,
	approvalCapabilities,
	compact,
	arrivedLive,
	queued,
	sending,
	queuedNote,
	highlighted,
	itemActivityAt,
	authorLink,
	onReply,
	sideLines,
	inAutomationFeed,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	onOpenItem,
	onOpenFile,
	onOpenDesktop,
	previews,
	liveFace,
}: {
	message: Message;
	/** Whether it heads its author's group, so it carries their face and name. */
	startsGroup: boolean;
	participants: Participant[];
	members: readonly PersonParticipant[];
	conversationKind: ConversationKind;
	looks: ReturnType<typeof useConnectionLooks>;
	/** The conversation's files by id, for the tool line's calls that read them. */
	fileNames: ReadonlyMap<string, string>;
	approvalCapabilities: ApprovalCapabilities | undefined;
	compact: boolean;
	/** Finished while the conversation was open, so it arrives rather than simply being there. */
	arrivedLive: boolean;
	/** Whether this message waits for the next reply, because one is still being written. */
	queued: boolean;
	/** Whether it is still on its way to the API, so it cannot be replied or reacted to yet. */
	sending: boolean;
	/** Whether it ends a run of waiting messages, which says so once under the last of them. */
	queuedNote: boolean;
	/** Whether it is pointed out for a moment, as one jumped to is. */
	highlighted: boolean;
	itemActivityAt?: ReadonlyMap<string, string>;
	/** Where its author's name leads. */
	authorLink?: AuthorLink;
	onReply?: (message: Message) => void;
	sideLines?: ReactNode;
	inAutomationFeed: boolean;
	onJumpToMessage?: (messageId: string) => void;
	reacting?: Reacting;
	/** Where a file attached to it is served. */
	fileUrlOf: (fileId: string) => string;
	onOpenItem: (conversationId: string) => void;
	onOpenFile?: (fileId: string) => void;
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
	if (author.kind === "automation_trigger") return null;

	// A tap is a touch screen's hover: it shows a follow-up's time, as hovering does.
	function toggleTimeOnTouch(event: MouseEvent) {
		if (startsGroup || !window.matchMedia(NO_HOVER).matches) return;
		// A tap in a mention's card, drawn elsewhere on the page, still reaches here through React.
		if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
		if (event.target.closest("a, button, [role=button]")) return;
		setTimeTapped((shown) => !shown);
	}
	const bot = author.kind === "bot" ? author : undefined;
	const size = ROW[compact ? "compact" : "regular"];
	const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call");
	const files = message.parts.filter((part): part is FilePart => part.type === "file");
	const segments = segmentsOf(message);
	const mentionable = [...participants, ...groupMentionsBy(author, members, conversationKind)];
	const words = segments
		.flatMap((segment) => (segment.type === "text" && segment.text ? [segment.text] : []))
		.join("\n\n");
	// A reply with nothing settled yet is only its typing line, under the last message.
	if (showsNothingYet(message)) return null;
	const finished = message.status === "complete" && !sending;
	const replyable = onReply !== undefined && finished;
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
			style={bot ? botColorVariables(bot.color) : undefined}
		>
			{/* A reply's face lines up with its author's name, under the quote. */}
			<span
				className={cn("flex shrink-0 justify-center", message.replyTo && "pt-5.25")}
				style={{ width: size.face }}
			>
				{startsGroup ? (
					<span aria-hidden className="mt-0.5 flex">
						{author.kind === "bot" && liveFace ? (
							<WatchingAvatar
								bot={author}
								size={size.face}
								busy={liveFace.botTyping}
								watching={liveFace.viewerWriting}
							/>
						) : author.kind === "bot" ? (
							<BotAvatar
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
				{message.replyTo && <RowReplyQuote replyTo={message.replyTo} onJump={onJumpToMessage} />}
				{startsGroup && (
					<div className="flex items-center gap-2 pb-px">
						<RowAuthorName name={author.name} link={authorLink} />
						{bot && (
							<span className="rounded bg-chip px-1.25 py-px font-semibold text-2xs text-muted-foreground leading-snug">
								Bot
							</span>
						)}
						<span className="text-subtle-foreground text-xs">
							<MessageTime createdAt={message.createdAt} />
						</span>
					</div>
				)}
				{bot && <ToolLine parts={message.parts} looks={looks} fileNames={fileNames} />}
				{segments.map((segment) => {
					if (segment.type === "collaboration") {
						const recipient = participants.find(
							(participant): participant is BotParticipant =>
								participant.kind === "bot" && participant.id === segment.collaboration.botId,
						);
						if (!bot || !recipient) return null;
						return (
							<CollaborationLine
								key={segment.key}
								initiator={bot}
								recipient={recipient}
								status={segment.collaboration.status}
								lastActivityAt={itemActivityAt?.get(segment.collaboration.conversationId)}
								onOpen={() => onOpenItem(segment.collaboration.conversationId)}
							/>
						);
					}
					if (segment.type === "tool_call") {
						const call = segment.toolCall;
						if (!bot) return null;
						return (
							<div key={segment.key} className="w-full max-w-115 pt-1.5 pb-1">
								<ToolApprovalCard
									call={call}
									bot={bot}
									conversationId={message.conversationId}
									canApprove={mayAnswer(call, bot.id, approvalCapabilities)}
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
							{bot && arrivedLive ? (
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
				{bot &&
					previews &&
					onOpenDesktop &&
					message.status === "streaming" &&
					calls.some((call) => call.tool.startsWith(BROWSER_TOOL_PREFIX)) && (
						<div className="w-full max-w-115 pt-2 pb-1.5">
							<LiveDesktopCard
								conversationId={message.conversationId}
								botId={bot.id}
								botName={bot.name}
								onOpen={onOpenDesktop}
							/>
						</div>
					)}
				{bot && previews && onOpenFile && (
					<FileCards
						parts={message.parts}
						botName={bot.name}
						onOpen={onOpenFile}
						className="pt-2"
					/>
				)}
				{sideLines}
				<MessageReactions message={message} reacting={reacting} addable={finished} />
				{message.automationResultOf && !inAutomationFeed && (
					<RowNote className="text-subtle-foreground">
						<AutomationResultLink run={message.automationResultOf} onOpenItem={onOpenItem} />
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
			{(words || replyable || reactable) && (
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
function RowReplyQuote({
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
function RowAuthorName({ name, link }: { name: string; link: AuthorLink | undefined }) {
	const className = "font-semibold text-sm text-foreground";
	if (!link) return <span className={className}>{name}</span>;
	const linkClassName = cn(className, "rounded hover:underline focus-ring");
	return link.kind === "bot" ? (
		<Link {...link.options} className={linkClassName}>
			{name}
		</Link>
	) : (
		<Link {...link.options} className={linkClassName}>
			{name}
		</Link>
	);
}

/** A line under a message's words, such as why a reply failed. */
function RowNote({ className, children }: { className: string; children: ReactNode }) {
	return <p className={cn("m-0 pt-1 text-xs", className)}>{children}</p>;
}

/** Where an automation's result came from, opening the run with the work behind it. */
function AutomationResultLink({
	run,
	onOpenItem,
}: {
	run: AutomationResultOf;
	onOpenItem: (conversationId: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpenItem(run.conversationId)}
			className="focus-ring inline-flex items-center gap-0.5 rounded-sm font-medium transition-colors hover:text-soft-foreground"
		>
			From {run.automationName}
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
const COLLABORATION_LINE_STATUS: Record<ActivityState, SideConversationStatus> = {
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
	initiator: BotParticipant;
	recipient: BotParticipant;
	status: CollaborationPart["status"];
	lastActivityAt?: string;
	onOpen: () => void;
}) {
	return (
		<SideConversationLine
			faces={[initiator, recipient]}
			label={`Asked ${recipient.name}`}
			description={`Open Collaboration: ${initiator.name} and ${recipient.name}`}
			lastActivityAt={lastActivityAt}
			status={COLLABORATION_LINE_STATUS[collaborationActivityState(status)]}
			onOpen={onOpen}
		/>
	);
}

/**
 * The collaboration a bot's message opened, inline in a bot's chat: what the
 * two said to each other, each with their face, name and time, and a button
 * opening it beside the chat. Followed live while it runs; once it is over it
 * is only read.
 */
function CollaborationCard({
	initiator,
	recipient,
	conversationId,
	status,
	participants,
	onOpen,
}: {
	initiator: BotParticipant;
	recipient: BotParticipant;
	conversationId: string;
	status: CollaborationPart["status"];
	participants: Participant[];
	onOpen: () => void;
}) {
	const running = collaborationActivityState(status) === "running";
	const conversation = useConversation(conversationId);
	useConversationEvents(running ? conversationId : undefined);
	const messages = (conversation.data?.messages ?? []).filter(
		(message) => message.author.kind === "bot" && !showsNothingYet(message),
	);
	return (
		<section
			aria-label={`${initiator.name} asked ${recipient.name} for help`}
			className="group/collaboration relative my-1 flex w-full flex-col gap-3 rounded-2xl border border-border bg-list px-4 py-3.5"
		>
			<IconButton
				label={`Open Collaboration: ${initiator.name} and ${recipient.name}`}
				side="top"
				onClick={onOpen}
				className="absolute top-2 right-2 size-7 rounded-md text-subtle-foreground opacity-0 transition-opacity hover:bg-chip hover:text-foreground group-focus-within/collaboration:opacity-100 group-hover/collaboration:opacity-100 [@media(hover:none)]:opacity-100 [&_svg]:size-3.5"
			>
				<SquareArrowOutUpRight aria-hidden />
			</IconButton>
			{conversation.isPending ? (
				<p className="m-0 text-subtle-foreground text-xs">Loading…</p>
			) : conversation.isError ? (
				<p className="m-0 text-subtle-foreground text-xs">
					This collaboration could not be loaded.
				</p>
			) : (
				messages.map((message) => (
					<CollaborationMessage key={message.id} message={message} participants={participants} />
				))
			)}
			{status === "failed" && <p className="m-0 text-destructive-text text-xs">Stopped</p>}
		</section>
	);
}

/** One bot's message in an inline collaboration: its face, name and time over its words. */
function CollaborationMessage({
	message,
	participants,
}: {
	message: Message;
	participants: Participant[];
}) {
	const { author } = message;
	if (author.kind !== "bot") return null;
	const words = segmentsOf(message).flatMap((segment) =>
		segment.type === "text" && segment.text ? [{ key: segment.key, text: segment.text }] : [],
	);
	return (
		<article
			aria-label={author.name}
			className="flex flex-col gap-1"
			style={botColorVariables(author.color)}
		>
			<header className="flex items-center gap-2 text-subtle-foreground text-xs">
				<span aria-hidden className="flex">
					<BotAvatar
						color={author.color}
						face={author.face}
						shape={author.shape}
						size={FACE_PX.bot}
					/>
				</span>
				<span className="font-medium text-soft-foreground">{author.name}</span>
				<MessageTime createdAt={message.createdAt} />
			</header>
			{words.map(({ key, text }) => (
				<div
					key={key}
					className="min-w-0 break-words pl-6 text-body-foreground text-sm leading-relaxed"
				>
					<MessageMarkdown text={text} mentionable={participants} writer={writerOf(author)} />
				</div>
			))}
		</article>
	);
}

/** What started an automation run, at the top of the run's conversation. */
function AutomationTriggerCard({ message }: { message: Message }) {
	if (message.author.kind !== "automation_trigger") return null;
	const source =
		message.author.triggerKind === "schedule"
			? "Scheduled trigger"
			: message.author.triggerKind === "webhook"
				? "Webhook trigger"
				: message.author.triggerKind === "github"
					? "Repository trigger"
					: "Manual run";
	return (
		<article aria-label={`${source} for ${message.author.automationName}`} className="px-5 pt-3.5">
			<div className="rounded-xl border border-border bg-list px-4 py-3">
				<div className="pb-1 font-semibold text-muted-foreground text-xs">
					{message.author.automationName} <span className="font-normal">{source}</span>
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
		<div className="flex items-center gap-3 px-5 pt-6 pb-1">
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="text-subtle-foreground text-xs">{formatDay(new Date(at))}</span>
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

/** The bots who wrote in the conversation, whose connections its tool calls went through. */
function speakersIn(messages: readonly Message[]): string[] {
	return [
		...new Set(
			messages.flatMap((message) => (message.author.kind === "bot" ? [message.author.id] : [])),
		),
	];
}

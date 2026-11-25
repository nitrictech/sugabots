import { botColorVariables } from "@sugabots/avatars";
import {
	type BotParticipant,
	type ChatKind,
	type FilePart,
	type MemberParticipant,
	type Message,
	type MessageReplyTo,
	messageAuthorName,
	type Participant,
	type ToolCallPart,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { CornerUpLeft, Reply } from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import { type ApprovalPermissions, mayAnswer } from "@/lib/approvals.ts";
import type { AuthorLink, PagedAuthor } from "@/lib/author-links.ts";
import { type MarkedConnector, useMarkedConnectors } from "@/lib/connectors.ts";
import { formatClockTime, formatDay, formatFullTimestamp } from "@/lib/list-time.ts";
import { BROWSER_TOOL_PREFIX, splitToolKey } from "@/lib/tool-names.ts";
import { BotAvatar, WatchingAvatar } from "@/shell/Bot.tsx";
import {
	ActivityCollapsible,
	ActivityCollapsibleContent,
	ActivityCollapsibleTrigger,
	ActivityLine,
	ActivityTitle,
} from "@/ui/activity.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { LabelledRule } from "@/ui/labelled-rule.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import {
	type AnsweringFace,
	isTyping,
	sameDay,
	segmentsOf,
	showsNothingYet,
	startsGroup,
	startsNewDay,
	startsRun,
} from "./chat-layout.ts";
import { LiveDesktopCard } from "./DesktopViewer.tsx";
import { FileCards } from "./FileCards.tsx";
import { InterruptTurnButton } from "./InterruptTurnButton.tsx";
import { type FileUrlOf, MessageFiles } from "./MessageFiles.tsx";
import { MessageMarkdown, writerOf } from "./MessageMarkdown.tsx";
import { AddReactionButton, MessageReactions, type Reacting } from "./MessageReactions.tsx";
import { groupMentionsBy } from "./mentions.tsx";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";
import { WorkedFor } from "./ToolLine.tsx";
import { type Typer, TypingIndicator } from "./TypingIndicator.tsx";

/*
 * A bot's message is drawn open on the page, its face and name at the head of
 * a group, then its parts in order. A member's message sits in a bubble.
 *
 * A reply's text is drawn once it is settled, never as it streams. What the
 * bot writes on the way is often the lead-in to a tool call ("Let me find
 * the cycle:"), and that cannot be told until the call arrives, so text drawn
 * live would show words and then take them back. Text is settled when the
 * reply finishes or when something follows it. While the turn runs, one line
 * says the bot is typing.
 *
 * Tool calls are not drawn as parts at all. They belong to the turn rather than
 * to the transcript: the work line above a reply is the way to what they did.
 * What the bot said just before a call is narration and goes with them. The
 * exception is a write somebody was asked to approve: it stopped the reply,
 * and whoever answered it may want to read again what they agreed to, so it
 * stays in the chat as its card, waiting or answered, mid-turn included.
 */

export function ChatMessages({
	messages,
	typing,
	participants,
	membersReachingProject,
	chatKind,
	projectId,
	dividers = true,
	onOpenFile,
	onOpenDesktop,
	previews = true,
	approvalPermissions,
	compact = false,
	queued = NONE_QUEUED,
	sending = NONE_SENDING,
	highlightedMessageId,
	authorLinkOf,
	onReply,
	sideLinesOf,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	answeringFace,
	viewerWriting = false,
	viewerId,
	namedBotId,
	nameColorsFor,
}: {
	messages: Message[];
	/**
	 * Where the messages say who is typing themselves: a bot typing its reply,
	 * and `host`, the bot the chat is with, while `isRunning` and its
	 * reply has not started. Without it the caller says who is typing, as a
	 * chat does under its composer.
	 */
	typing?: { host: BotParticipant | undefined; isRunning: boolean };
	/** Everyone in the chat and the project's bots and members: who a mention can name. */
	participants: Participant[];
	/** The members who reach the project, whom a member's `@here` or `@channel` would notify. */
	membersReachingProject: readonly MemberParticipant[];
	/** What kind of chat it is, which decides whether `@here` and `@channel` notify anyone. */
	chatKind: ChatKind;
	/**
	 * The project the chat is in, a bot's default one or one members
	 * made, whose connectors its tools may come from.
	 */
	projectId?: string | null;
	/**
	 * Day markers between messages. Off where the caller places its own, as the
	 * chat does between these messages and its activity rows.
	 */
	dividers?: boolean;
	/** Opens a file a reply wrote, from its card. Without it, no cards are drawn. */
	onOpenFile?: (fileId: string) => void;
	/**
	 * Opens the bot's desktop from its screen, shown live in a reply while the
	 * reply uses the browser. Without it, no screen is shown.
	 */
	onOpenDesktop?: () => void;
	/**
	 * Whether replies show what they made: a card for each file, the
	 * desktop live. Off while one is open large beside the chat.
	 */
	previews?: boolean;

	/** What the member may decide of the approvals the chat raises. */
	approvalPermissions?: ApprovalPermissions;
	/** The sidebar's narrower chat: smaller faces and words. */
	compact?: boolean;
	/**
	 * Members' messages that wait for the next reply, because one is still being
	 * written: `queuedBehindReply` over the whole chat, not only these
	 * messages, since the reply may sit in an earlier run of them.
	 */
	queued?: ReadonlySet<string>;
	/**
	 * The user's messages still on their way to the API. Until it has them they
	 * cannot be replied or reacted to, as neither would find them there.
	 */
	sending?: ReadonlySet<string>;
	/** A message pointed out for a moment, as one jumped to is. */
	highlightedMessageId?: string;
	/** Where an author's name leads. Names are plain text without it. */
	authorLinkOf?: (author: PagedAuthor) => AuthorLink | undefined;
	/** Starts a reply quoting the message, from its hover toolbar. Without it, none is offered. */
	onReply?: (message: Message) => void;
	/** The lines of the chats a bot's message started, drawn under it. */
	sideLinesOf?: (message: Message) => ReactNode;
	/** Goes to the message a reply quotes, from its quote. Without it, the quote is only read. */
	onJumpToMessage?: (messageId: string) => void;
	/**
	 * How the member reacts to messages: from the hover toolbar, and by clicking
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
	/** The member reading, whose own messages are drawn on the right. Without it, everyone's are drawn alike. */
	viewerId?: string;
	/**
	 * The bot the chat's header already names, as a bot's chat names its own
	 * bot; its messages carry no face and name of their own. Without it, every
	 * bot's run of messages is headed by its face and name.
	 */
	namedBotId?: string;
	/**
	 * The chat members' name colours are picked for, so a member keeps
	 * theirs on a message brought in from elsewhere. By default, each message's
	 * own chat.
	 */
	nameColorsFor?: string;
}) {
	// The turn has started but its reply has not been created yet.
	const pendingReplier =
		typing?.isRunning && messages.at(-1)?.author.kind === "member" ? typing.host : undefined;
	const speakers = useMemo(() => speakersIn(messages), [messages]);
	const markedConnectorsOf = useMarkedConnectors(speakers, projectId);
	const fileNames = useMemo(() => fileNamesIn(messages), [messages]);
	const watchedWritten = useRepliesWatchedBeingWritten(messages);
	return (
		<div className="flex flex-col">
			{messages.map((message, index) => {
				const previous = messages[index - 1];
				const next = messages[index + 1];
				const divider = dividers && startsNewDay(previous?.createdAt, message.createdAt);
				const headsRun = startsRun(previous, message, dividers);
				// One note for each member's run of waiting messages, under the last of them.
				const queuedNote =
					queued.has(message.id) &&
					(next === undefined ||
						!queued.has(next.id) ||
						startsGroup(message, next) ||
						!sameDay(message, next));
				return (
					<Fragment key={message.id}>
						{divider && <DaySeparator at={message.createdAt} />}
						<ChatMessage
							message={message}
							startsGroup={headsRun}
							viewerId={viewerId}
							namedBotId={namedBotId}
							nameColorsFor={nameColorsFor}
							liveFace={
								message.id === answeringFace?.messageId
									? { botTyping: answeringFace.botTyping, viewerWriting }
									: undefined
							}
							participants={participants}
							membersReachingProject={membersReachingProject}
							chatKind={chatKind}
							markedConnectors={
								message.author.kind === "bot"
									? markedConnectorsOf(message.author.id)
									: NO_MARKED_CONNECTORS
							}
							fileNames={fileNames}
							approvalPermissions={approvalPermissions}
							compact={compact}
							arrivedLive={watchedWritten.has(message.id)}
							queued={queued.has(message.id)}
							sending={sending.has(message.id)}
							queuedNote={queuedNote}
							highlighted={message.id === highlightedMessageId}
							authorLinkOf={authorLinkOf}
							onReply={onReply}
							sideLines={sideLinesOf?.(message)}
							onJumpToMessage={onJumpToMessage}
							reacting={reacting}
							fileUrlOf={fileUrlOf}
							onOpenFile={onOpenFile}
							onOpenDesktop={onOpenDesktop}
							previews={previews}
						/>
						{typing && message.author.kind === "bot" && isTyping(message) && (
							<TypingIndicator key={`${message.id}-typing`} typers={[message.author]} />
						)}
						{message.status === "writing" && message.author.kind === "bot" && (
							<InterruptTurnFor
								chatId={message.chatId}
								replyId={message.id}
								botName={message.author.name}
								permissions={approvalPermissions}
							/>
						)}
					</Fragment>
				);
			})}
			{pendingReplier && <TypingIndicator typers={[pendingReplier]} />}
		</div>
	);
}

/**
 * Who is typing after `messages`: the bot writing the last of them, and the
 * members writing in the composer.
 */
export function typersAfter(
	messages: readonly Message[],
	membersTyping: readonly MemberParticipant[],
): Typer[] {
	const last = messages.at(-1);
	if (last?.author.kind === "bot" && isTyping(last)) return [last.author, ...membersTyping];
	return [...membersTyping];
}

interface AnsweringFaceState {
	botTyping: boolean;
	viewerWriting: boolean;
}

/**
 * The ids of replies this chat has seen while they were still being written.
 * One that is finished and in here arrived while someone watched, as opposed
 * to being loaded with the chat's history. Only ever added to, so a reply
 * keeps its arrival for as long as the chat stays open.
 */
function useRepliesWatchedBeingWritten(messages: readonly Message[]): ReadonlySet<string> {
	const seen = useRef(new Set<string>());
	for (const message of messages) {
		if (message.status === "writing") seen.current.add(message.id);
	}
	return seen.current;
}

const NONE_QUEUED: ReadonlySet<string> = new Set();
/** Where a file is served while its message is still being sent: nowhere yet. */
const notServedYet: FileUrlOf = () => undefined;

const NONE_SENDING: ReadonlySet<string> = new Set();

/** How long a reply takes to grow to fit its words: longer for more of them, within bounds. */
const REVEAL_MS = { minimum: 400, maximum: 700, perCharacter: 0.5 };

function revealDurationMs(text: string): number {
	const scaled = REVEAL_MS.minimum + text.length * REVEAL_MS.perCharacter;
	return Math.round(Math.min(scaled, REVEAL_MS.maximum));
}

/** The names of the files attached in the chat, by id. */
function fileNamesIn(messages: readonly Message[]): ReadonlyMap<string, string> {
	return new Map(
		messages.flatMap((message) =>
			message.parts.flatMap((part) =>
				part.type === "file" ? [[part.id, part.name] as const] : [],
			),
		),
	);
}

/** How big a face is beside its author's name: a bot's over its words, a member's in their bubble. */
const FACE_PX = { bot: 16, member: 16 } as const;

/** How the words of a message are set: the regular chat, or the sidebar's narrower chat. */
const WORDS = {
	regular: "text-sm leading-relaxed",
	compact: "text-sm leading-normal",
} as const;

/**
 * Which way a message is drawn: a bot's words open on the page under its
 * name, someone else's in an outlined bubble beside their face, and the
 * viewer's own in a filled bubble on the right.
 */
type RowSide = "bot" | "member" | "mine";

/**
 * One message. A bot's carries its face, name and
 * time at the head of a group, then its work line, words, and any call
 * somebody was asked to approve as its card,
 * with a row of actions under it. A member's words sit in a bubble: someone else's on the
 * left, headed by their name, the viewer's own on the right over its time. A reply
 * quotes the message it answers above its words, and members' reactions sit
 * under them.
 */
function ChatMessage({
	message,
	startsGroup,
	viewerId,
	namedBotId,
	nameColorsFor,
	participants,
	membersReachingProject,
	chatKind,
	markedConnectors,
	fileNames,
	approvalPermissions,
	compact,
	arrivedLive,
	queued,
	sending,
	queuedNote,
	highlighted,
	authorLinkOf,
	onReply,
	sideLines,
	onJumpToMessage,
	reacting,
	fileUrlOf,
	onOpenFile,
	onOpenDesktop,
	previews,
	liveFace,
}: {
	message: Message;
	/** Whether it heads its author's group, so it carries their face and name. */
	startsGroup: boolean;
	/** The member reading, whose own messages are drawn on the right. */
	viewerId: string | undefined;
	/** The bot the chat's header names, whose face and name are there rather than over its messages. */
	namedBotId: string | undefined;
	/** The chat members' name colours are picked for; each message's own without it. */
	nameColorsFor: string | undefined;
	participants: Participant[];
	membersReachingProject: readonly MemberParticipant[];
	chatKind: ChatKind;
	/** The connectors its bot's calls were made with, by handle. */
	markedConnectors: ReadonlyMap<string, MarkedConnector>;
	/** The chat's files by id, for the work line's calls that read them. */
	fileNames: ReadonlyMap<string, string>;
	approvalPermissions: ApprovalPermissions | undefined;
	compact: boolean;
	/** Finished while the chat was open, so it arrives rather than simply being there. */
	arrivedLive: boolean;
	/** Whether this message waits for the next reply, because one is still being written. */
	queued: boolean;
	/** Whether it is still on its way to the API, so it cannot be replied or reacted to yet. */
	sending: boolean;
	/** Whether it ends a run of waiting messages, which says so once under the last of them. */
	queuedNote: boolean;
	/** Whether it is pointed out for a moment, as one jumped to is. */
	highlighted: boolean;
	/** Where its author's name leads. */
	authorLinkOf?: (author: PagedAuthor) => AuthorLink | undefined;
	onReply?: (message: Message) => void;
	sideLines?: ReactNode;
	onJumpToMessage?: (messageId: string) => void;
	reacting?: Reacting;
	/** Where a file attached to it is served. */
	fileUrlOf: (fileId: string) => string;
	onOpenFile?: (fileId: string) => void;
	onOpenDesktop?: () => void;
	previews: boolean;
	/** Given only where the face of the bot answering is drawn: whether it's typing, and whether the viewer is writing back. */
	liveFace?: AnsweringFaceState;
}) {
	// The actions stay up while their emoji picker is open, as the pointer has left the row for it.
	const [picking, setPicking] = useState(false);
	const { author } = message;
	// Only a run's own chat has its trigger, and the run's panel leaves it out.
	if (author.kind === "automation_trigger") return null;
	const authorLink = authorLinkOf?.(author);
	// A reply with nothing settled yet is only its typing line, under the last message.
	if (showsNothingYet(message)) return null;

	const bot = author.kind === "bot" ? author : undefined;
	const side: RowSide = bot ? "bot" : author.id === viewerId ? "mine" : "member";
	const calls = message.parts.filter((part): part is ToolCallPart => part.type === "tool_call");
	const files = message.parts.filter((part): part is FilePart => part.type === "file");
	const segments = segmentsOf(message);
	const mentionable = [
		...participants,
		...groupMentionsBy(author, membersReachingProject, chatKind),
	];
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
			tone={quoteToneOf(message.replyTo.author, nameColorsFor ?? message.chatId)}
		/>
	);

	const parts = segments.map((segment) => {
		if (segment.type === "tool_call") {
			const call = segment.toolCall;
			if (!bot) return null;
			return (
				<div key={segment.key} className="w-full max-w-115 pt-1.5 pb-1">
					<ToolApprovalCard
						call={call}
						bot={bot}
						chatId={message.chatId}
						canApprove={mayAnswer(call, message.id, approvalPermissions)}
						connector={markedConnectors.get(splitToolKey(call.tool).handle)}
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
			{message.status === "failed" && (
				<RowNote className="text-destructive-text">
					<span className="font-semibold">Reply failed.</span>
					{message.error && <span> {message.error}</span>}
				</RowNote>
			)}
			{message.status === "cancelled" && (
				<RowNote className="font-semibold text-subtle-foreground">Reply interrupted</RowNote>
			)}
			{queuedNote && <RowNote className="text-subtle-foreground">Queued</RowNote>}
		</>
	);
	const fileList = files.length > 0 && (
		<MessageFiles files={files} urlOf={sending ? notServedYet : fileUrlOf} />
	);
	// The bot the header names carries no head of its own.
	const headed = startsGroup && !(bot !== undefined && bot.id === namedBotId);
	// Shown with the actions on messages without a head, which would carry it.
	const followUpTime = !headed && (
		<span className="px-1 text-2xs text-subtle-foreground tabular-nums">
			<MessageTime createdAt={message.createdAt} />
		</span>
	);

	return (
		<article
			aria-label={`${author.name}, ${messageStatus(message, { queued })}`}
			aria-busy={message.status === "writing"}
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
										eyes={bot.eyes}
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
						<WorkedFor
							message={message}
							markedConnectors={markedConnectors}
							fileNames={fileNames}
							className="mb-1.5"
						/>
						{parts}
						{message.thinking && message.thinking.length > 0 && (
							<ActivityCollapsible>
								<ActivityCollapsibleTrigger>
									<ActivityLine>
										<ActivityTitle>Thinking</ActivityTitle>
									</ActivityLine>
								</ActivityCollapsibleTrigger>
								<ActivityCollapsibleContent className="space-y-2 text-sm">
									{message.thinking.map(({ step, text }) => (
										<p key={step} className="whitespace-pre-wrap">
											{text}
										</p>
									))}
								</ActivityCollapsibleContent>
							</ActivityCollapsible>
						)}
						{fileList}
						{previews &&
							onOpenDesktop &&
							message.status === "writing" &&
							calls.some((call) => call.tool.startsWith(BROWSER_TOOL_PREFIX)) && (
								<div className="w-full max-w-115 pt-1">
									<LiveDesktopCard
										chatId={message.chatId}
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
					<MessageToolbar
						side={side}
						message={message}
						reacting={reacting}
						picking={picking}
						className="pt-1"
					>
						{finished && (
							<>
								{actions}
								{followUpTime}
							</>
						)}
					</MessageToolbar>
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
										side === "mine" ? "bubble-mine" : "bg-bubble",
									)}
								>
									{startsGroup && side === "member" && (
										<header className="flex items-center gap-1.5 pb-0.5 text-xs">
											{author.kind === "member" && (
												<span aria-hidden className="flex">
													<MemberAvatar member={author} size={FACE_PX.member} />
												</span>
											)}
											<AuthorName
												name={author.name}
												link={authorLink}
												colorClassName={
													nameColorIn(nameColorsFor ?? message.chatId, author.id).text
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
						<MessageToolbar side={side} message={message} reacting={reacting} picking={picking}>
							{actions}
							<span className="px-1.5 text-2xs text-subtle-foreground tabular-nums">
								<MessageTime createdAt={message.createdAt} />
							</span>
						</MessageToolbar>
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
			{words && <CopyIconButton label="Copy text" text={words} side="top" variant="toolbar" />}
			{reacting && (
				<AddReactionButton message={message} reacting={reacting} onOpenChange={onPickingChange} />
			)}
			{onReply && (
				<IconButton label="Reply" side="top" variant="toolbar" onClick={() => onReply(message)}>
					<Reply aria-hidden />
				</IconButton>
			)}
		</>
	);
}

/**
 * Under a message, its reactions, then `children`, what can be done to it and
 * its time, shown while the message is pointed at or its emoji picker is
 * open. Under your own the row runs from the right, so the reactions keep to
 * the bubble's edge and the rest opens out to their left. A rule parts the
 * reactions from the rest once there are any.
 */
function MessageToolbar({
	side,
	message,
	reacting,
	picking,
	className,
	children,
}: {
	side: RowSide;
	message: Message;
	reacting: Reacting | undefined;
	/** Whether its emoji picker is open, which keeps the row up once the pointer has left for it. */
	picking: boolean;
	className?: string;
	children: ReactNode;
}) {
	const reacted = (message.reactions?.length ?? 0) > 0;
	const rule = reacted && (
		<span
			aria-hidden
			className={cn("h-3.5 w-px bg-border-strong", side === "bot" ? "mr-1.5 ml-1" : "mx-1.5")}
		/>
	);
	return (
		<div
			className={cn(
				"flex min-h-7 flex-wrap items-center gap-1",
				side === "mine" && "flex-row-reverse",
				className,
			)}
		>
			<MessageReactions message={message} reacting={reacting} />
			{children && (
				<div
					className={cn(
						"flex items-center gap-0.5 transition-opacity group-has-focus-visible/message:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100",
						!reacted && (side === "mine" ? "-mr-1.5" : "-ml-1.5"),
						picking ? "opacity-100" : "opacity-0",
					)}
				>
					{side !== "mine" && rule}
					{children}
					{side === "mine" && rule}
				</div>
			)}
		</div>
	);
}

/** How a name is coloured, with the variables a bot's colour needs. */
interface QuoteTone {
	text: string;
	style?: CSSProperties;
}

/** The colour of a quote of `author`'s message: their name's colour in this chat, or a bot's own colour. */
function quoteToneOf(author: MessageReplyTo["author"], chatId: string): QuoteTone {
	if (author.kind === "member") return nameColorIn(chatId, author.id);
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
			<span className="min-w-0 truncate text-subtle-foreground transition-colors group-hover/quote:text-muted-foreground">
				{replyTo.preview}
			</span>
		</>
	);
	const className =
		"flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left text-xs leading-snug";
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
				// The preview is already in the faintest ink AA allows, so the quote lifts on hover rather than dimming at rest.
				"group/quote focus-ring rounded-r-sm",
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
	/** The colour it is set in, as a group chat tells its members apart; muted without one. */
	colorClassName?: string;
}) {
	const className = cn(
		"font-medium text-xs",
		colorClassName ?? "text-muted-foreground hover:text-foreground",
	);
	if (!link) {
		return <span className={className}>{name}</span>;
	}
	return (
		<Link {...link} className={cn(className, "rounded hover:underline focus-ring")}>
			{name}
		</Link>
	);
}

/** The colours names are set in, each made to read in both themes. */
const NAME_COLORS = [
	{ text: "text-name-1" },
	{ text: "text-name-2" },
	{ text: "text-name-3" },
	{ text: "text-name-4" },
	{ text: "text-name-5" },
	{ text: "text-name-6" },
	{ text: "text-name-7" },
	{ text: "text-name-8" },
	{ text: "text-name-9" },
	{ text: "text-name-10" },
] as const;

/**
 * The colour a member's name is set in within one chat: the same there every
 * time, but picked again in each chat, as a messaging app's groups do.
 */
function nameColorIn(chatId: string, memberId: string): QuoteTone {
	let hash = 0;
	for (const character of `${chatId}:${memberId}`) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	}
	return NAME_COLORS[hash % NAME_COLORS.length] ?? NAME_COLORS[0];
}

function MessageTime({ createdAt }: { createdAt: string }) {
	return (
		<Tooltip label={formatFullTimestamp(createdAt)} side="top">
			<time dateTime={createdAt} className="whitespace-nowrap hover:underline">
				{formatClockTime(new Date(createdAt))}
			</time>
		</Tooltip>
	);
}

/** A line under a message's words, such as why a reply failed. */
function RowNote({ className, children }: { className: string; children: ReactNode }) {
	return <p className={cn("m-0 pt-1 text-xs", className)}>{children}</p>;
}

/** Where the chat moves on to a new day: a rule either side of "Today", "Yesterday" or the date. */
export function DaySeparator({ at }: { at: string }) {
	return <LabelledRule className="pt-6 pb-1">{formatDay(new Date(at))}</LabelledRule>;
}

function messageStatus(message: Message, { queued }: { queued: boolean }): string {
	if (queued) {
		return "queued";
	}
	if (message.status === "failed") {
		return "failed";
	}
	if (message.status === "cancelled") {
		return "interrupted";
	}
	return formatClockTime(new Date(message.createdAt));
}

/** A member's message makes no calls, so no connector names any. */
const NO_MARKED_CONNECTORS: ReadonlyMap<string, MarkedConnector> = new Map();

/** The bots who wrote in the chat, whose connectors its tool calls went through. */
function speakersIn(messages: readonly Message[]): string[] {
	return [
		...new Set(
			messages.flatMap((message) => (message.author.kind === "bot" ? [message.author.id] : [])),
		),
	];
}

/** The interrupt control under the reply `replyId` being written, when the member may interrupt its turn. */
function InterruptTurnFor({
	chatId,
	replyId,
	botName,
	permissions,
}: {
	chatId: string;
	replyId: string;
	botName: string;
	permissions: ApprovalPermissions | undefined;
}) {
	const interruptible = permissions?.interruptTurns.find((turn) => turn.replyId === replyId);
	if (!interruptible) return null;
	return <InterruptTurnButton chatId={chatId} turnId={interruptible.turnId} botName={botName} />;
}

import type {
	ChatHistoryEntry,
	CollaborationPart,
	Message,
	SessionUser,
	ThreadParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import { Fragment } from "react";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ChatActivityRow } from "./ChatActivityRow.tsx";
import { CollaborationThread } from "./CollaborationThread.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { textWithMentions } from "./mentions.tsx";
import { ToolCallRow } from "./ToolCallRow.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/*
 * A message is drawn as its parts, in order: each run of text is a bubble,
 * each collaboration is the child thread it opened, at full width, and each tool
 * call is a compact row. So an agent that writes, asks another agent, and
 * writes again shows as a bubble, a child thread, and a bubble, in the order
 * it happened.
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
	const showThinking = isRunning && lastMessage?.author.kind === "person";
	return (
		<div className="flex flex-col gap-[17px]">
			{messages.map((message, index) => {
				const divider = dividers ? dividerBefore(messages[index - 1], message) : undefined;
				return (
					<Fragment key={message.id}>
						{divider && <ActivityDivider>{divider}</ActivityDivider>}
						{segmentsOf(message).map((segment, position, all) => {
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
								return (
									<ToolCallRow
										key={segment.key}
										call={segment.toolCall}
										threadId={message.threadId}
										podId={podId}
										canApprove={canApproveToolCalls}
										canAlwaysAllow={canAlwaysAllowToolCalls}
									/>
								);
							}
							return (
								<MessageBubble
									key={segment.key}
									message={message}
									text={segment.text}
									outgoing={
										(message.author.kind === "person" && message.author.id === user.id) ||
										(hostAgentOnRight &&
											message.author.kind === "agent" &&
											message.author.id === host.id)
									}
									mentionable={mentionable}
									isLast={position === all.length - 1}
									waitingOn={segment.waitingOn}
								/>
							);
						})}
					</Fragment>
				);
			})}
			{showThinking && <ThinkingBubble agent={host} outgoing={hostAgentOnRight} />}
		</div>
	);
}

type Segment =
	| { type: "text"; key: string; text: string; waitingOn?: string }
	| { type: "collaboration"; key: string; collaboration: CollaborationPart }
	| { type: "tool_call"; key: string; toolCall: ToolCallPart };

/**
 * The message's parts as things to draw. A streaming reply whose last part is
 * a collaboration or a tool call gets a trailing bubble that says what it is
 * waiting for, which is where its next words will land.
 */
function segmentsOf(message: Message): Segment[] {
	// A text run is keyed by where in the message it starts, which is stable as
	// the run grows; a collaboration or tool call by its id.
	let written = 0;
	const segments: Segment[] = message.parts.map((part) => {
		if (part.type === "text") {
			const segment: Segment = { type: "text", key: `text@${written}`, text: part.text };
			written += part.text.length;
			return segment;
		}
		if (part.type === "collaboration") {
			return { type: "collaboration", key: part.id, collaboration: part };
		}
		return { type: "tool_call", key: part.id, toolCall: part };
	});
	const last = segments.at(-1);
	if (
		message.status === "streaming" &&
		(last?.type === "collaboration" || last?.type === "tool_call")
	) {
		segments.push({
			type: "text",
			key: `text@${written}`,
			text: "",
			waitingOn: last.type === "collaboration" ? last.collaboration.agentName : last.toolCall.tool,
		});
	}
	if (segments.length === 0) {
		segments.push({ type: "text", key: "text@0", text: "" });
	}
	return segments;
}

/** The time or status beside an author's name, lighter so the name leads without a separator. */
const authorDetailClass = "font-normal text-muted-foreground text-xs";

function ThinkingBubble({ agent, outgoing }: { agent: AgentParticipant; outgoing: boolean }) {
	return (
		<article
			aria-label={`${agent.name}, thinking`}
			className={`agent-tint flex animate-rise motion-reduce:animate-none ${outgoing ? "justify-end pl-8 pr-3.5" : "justify-start pl-3.5 pr-8"}`}
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<div className="relative max-w-[min(100%,480px)]">
				<AgentAvatar
					hue={agent.hue}
					face={agent.face}
					size={38}
					ringed
					className={`absolute -top-[11px] z-10 ${outgoing ? "-right-[15px]" : "-left-[15px]"}`}
				/>
				<div className="rounded-4xl bg-agent-wash px-5 py-3.5">
					<div
						className={`flex items-baseline gap-x-2 pb-1 font-semibold text-agent-name text-md ${outgoing ? "justify-end pr-5" : "pl-5"}`}
					>
						<span>{agent.name}</span>
						<span className={authorDetailClass}>thinking…</span>
					</div>
					<ThinkingDots />
				</div>
			</div>
		</article>
	);
}

function MessageBubble({
	message,
	text,
	outgoing,
	mentionable,
	isLast,
	waitingOn,
}: {
	message: Message;
	/** This bubble's run of text; a message with a collaboration in it has several. */
	text: string;
	outgoing: boolean;
	mentionable: ThreadParticipant[];
	/** Whether this is the message's last bubble, where its streaming state shows. */
	isLast: boolean;
	/** The collaborator this bubble is waiting on before its words arrive. */
	waitingOn?: string;
}) {
	if (message.author.kind === "routine_trigger") {
		return <RoutineTriggerBubble message={message} text={text} />;
	}
	const agent = message.author.kind === "agent" ? message.author : undefined;
	const fromAgent = agent !== undefined;
	const streaming = isLast && message.status === "streaming";
	const status = messageStatus(message);
	return (
		<article
			aria-label={`${message.author.name}, ${status}`}
			className={`agent-tint flex animate-rise motion-reduce:animate-none ${outgoing ? "justify-end pl-8 pr-3.5" : "justify-start pl-3.5 pr-8"}`}
			style={agent ? { ["--agent-hue" as string]: agent.hue } : undefined}
		>
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
						className={`flex flex-wrap items-baseline gap-x-2 pb-1 font-semibold text-md ${
							outgoing ? "justify-end pr-5" : "pl-5"
						} ${fromAgent ? "text-agent-name" : "text-muted-foreground"}`}
					>
						<span>{message.author.name}</span>
						{streaming ? (
							<span className={authorDetailClass}>
								{waitingOn ? `waiting on ${waitingOn}…` : "writing…"}
							</span>
						) : (
							<Tooltip label={formatFullTimestamp(message.createdAt)} side="top">
								<time
									dateTime={message.createdAt}
									className={`${authorDetailClass} cursor-default hover:underline`}
								>
									{formatTime(message.createdAt)}
								</time>
							</Tooltip>
						)}
					</div>
					{fromAgent ? (
						<MessageMarkdown text={text} mentionable={mentionable} streaming={streaming} />
					) : (
						<p className="m-0 whitespace-pre-wrap break-words text-foreground text-xl leading-relaxed">
							{textWithMentions(text, mentionable)}
						</p>
					)}
					{streaming && !text && <ThinkingDots />}
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

function ThinkingDots() {
	return (
		<span className="flex h-7 items-center gap-1.5 px-1" aria-hidden>
			<span className="size-2 animate-bounce rounded-full bg-agent-name motion-reduce:animate-none" />
			<span className="size-2 animate-bounce rounded-full bg-agent-name [animation-delay:150ms] motion-reduce:animate-none" />
			<span className="size-2 animate-bounce rounded-full bg-agent-name [animation-delay:300ms] motion-reduce:animate-none" />
		</span>
	);
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

const dateWithYear: Intl.DateTimeFormatOptions = {
	month: "short",
	day: "numeric",
	year: "numeric",
};

/** "Today", "Yesterday", or the date in `dateFormat`. */
function formatDay(date: Date, dateFormat = dateWithYear): string {
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
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
		new Date(createdAt),
	);
}

function messageStatus(message: Message): string {
	if (message.status === "streaming") {
		return "writing";
	}
	if (message.status === "failed") {
		return "failed";
	}
	if (message.status === "cancelled") {
		return "stopped";
	}
	return formatTime(message.createdAt);
}

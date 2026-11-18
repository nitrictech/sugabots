import type {
	Bot,
	BotParticipant,
	ChatHistoryEntry,
	ChatMessageItem,
	ConversationDetails,
	Message,
	Participant,
	SessionUser,
} from "@sugabots/contracts";
import { Pause } from "lucide-react";
import { Fragment } from "react";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { useReactions } from "@/lib/reactions.ts";
import { NextRunDivider, RunDivider, RunMessage } from "./AutomationRun.tsx";
import { BotStartedTaskLine, tasksStartedBy } from "./BotStartedTaskLine.tsx";
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ConversationMessages, DaySeparator, type MessageLook } from "./ConversationMessages.tsx";
import { chatGroupsOf, latestRunId, messagesIn } from "./chat-items.ts";
import { findAnsweringFace } from "./conversation-layout.ts";
import { queuedBehindReply } from "./queued-messages.ts";

/**
 * A chat's items in order: its messages, a run of them at a time, between
 * automation runs and pauses, each day behind a separator, or in an
 * automation's feed, each run. An automation's feed ends with when it runs next.
 */
export function ChatTimeline({
	items,
	details,
	host,
	bot,
	conversationId,
	user,
	look,
	mentionable,
	entries,
	sending,
	viewerWriting,
	pointedOut,
	previews,
	onOpenItem,
	onOpenFile,
	onOpenDesktop,
	onReply,
	onJumpToMessage,
}: {
	items: readonly ChatMessageItem[];
	details: ConversationDetails;
	/** The bot the task is with; none in a channel or a direct message. */
	host: BotParticipant | undefined;
	/** The chat's own bot; null in a channel or a direct message. */
	bot: Bot | null;
	conversationId: string;
	user: SessionUser;
	/** How the messages are drawn: rows, as channels and direct messages have them, or as a bot's task. */
	look: MessageLook;
	/** Everyone here and the channel's bots and people. */
	mentionable: Participant[];
	/** The runs and collaborations opened beside the chat. */
	entries: readonly ChatHistoryEntry[];
	/** The viewer's messages still on their way to the API. */
	sending: ReadonlySet<string>;
	/** Whether the viewer has a draft, so a bot's face waiting to answer stays still. */
	viewerWriting: boolean;
	/** A message pointed out for a moment, as one jumped to is. */
	pointedOut: string | undefined;
	/** Whether replies show what they made; off while something is open large beside the chat. */
	previews: boolean;
	onOpenItem: (itemConversationId: string) => void;
	onOpenFile: (fileId: string) => void;
	onOpenDesktop: () => void;
	onReply: (message: Message) => void;
	onJumpToMessage: (messageId: string) => void;
}) {
	const authorLinkOf = useAuthorLinks();
	const reactions = useReactions(user);
	const reacting = { userId: user.id, onToggle: reactions.toggle, onAdd: reactions.add };
	const automationFeed = details.conversation.kind === "automation_feed";
	const groups = chatGroupsOf(items, automationFeed);
	const shownMessages = messagesIn(items);
	// Found across all the messages, not in each part they're shown in, or each part would bring a face of its own alive.
	const answeringFace = findAnsweringFace(shownMessages, false);
	const queued = queuedBehindReply(shownMessages, details.queuedSince);
	const itemActivityAt = new Map(
		entries.map((entry) => [entry.conversationId, entry.latestActivityAt]),
	);
	return (
		<>
			{groups.map((group) => (
				<Fragment key={group.key}>
					{group.separated &&
						(automationFeed ? <RunDivider at={group.at} /> : <DaySeparator at={group.at} />)}
					{group.kind === "messages" ? (
						<ConversationMessages
							messages={group.messages}
							host={host}
							isRunning={false}
							participants={mentionable}
							members={details.members}
							conversationKind={details.conversation.kind}
							dividers={false}
							onOpenItem={onOpenItem}
							onOpenFile={onOpenFile}
							onOpenDesktop={onOpenDesktop}
							fileUrlOf={(fileId) => chatFileUrl(conversationId, fileId)}
							previews={previews}
							approvalCapabilities={details.capabilities}
							queued={queued}
							sending={sending}
							showsTyping={false}
							answeringFace={answeringFace}
							viewerWriting={viewerWriting}
							viewerId={user.id}
							look={look}
							nameColorsFor={conversationId}
							highlightedMessageId={pointedOut}
							itemActivityAt={itemActivityAt}
							authorLinkOf={authorLinkOf}
							onReply={onReply}
							inAutomationFeed={automationFeed}
							sideLinesOf={(message) =>
								tasksStartedBy(message).map((started) => (
									<BotStartedTaskLine
										key={started.id}
										started={started}
										startedBy={message.author}
										channelBots={details.channelBots}
										bot={bot}
									/>
								))
							}
							onJumpToMessage={onJumpToMessage}
							reacting={reacting}
						/>
					) : group.item.kind === "automation_paused" ? (
						<PausedLine at={group.item.createdAt} />
					) : details.automation && host ? (
						<RunMessage
							item={group.item}
							bot={host}
							automation={details.automation}
							conversationId={conversationId}
							latest={details.automation.failed && group.item.id === latestRunId(items)}
							mentionable={mentionable}
						/>
					) : (
						<RunLine item={group.item} entries={entries} onOpenItem={onOpenItem} />
					)}
				</Fragment>
			))}
			{details.automation && <NextRunDivider automation={details.automation} />}
		</>
	);
}

/** An automation run, as a row among the messages. */
function RunLine({
	item,
	entries,
	onOpenItem,
}: {
	item: Extract<ChatMessageItem, { kind: "run" }>;
	/** The runs and collaborations opened beside the chat, where how a run stands is read. */
	entries: readonly ChatHistoryEntry[];
	onOpenItem: (itemConversationId: string) => void;
}) {
	return (
		<ChatActivityRow
			type="run"
			automationName={item.automationName}
			triggerKind={item.triggerKind}
			state={activityStateOf(entries.find((entry) => entry.conversationId === item.conversationId))}
			at={item.createdAt}
			onOpen={() => onOpenItem(item.conversationId)}
		/>
	);
}

/** In an automation's feed: that it paused itself after failing twice in a row, and when. */
function PausedLine({ at }: { at: string }) {
	return (
		<p className="m-0 flex items-center gap-2 px-5 py-2 font-medium text-xs text-muted-foreground">
			<Pause aria-hidden size={14} strokeWidth={2} className="shrink-0" />
			Paused after two failed runs in a row.
			<span className="font-normal text-xs text-subtle-foreground">
				{formatListTime(new Date(at), new Date())}
			</span>
		</p>
	);
}

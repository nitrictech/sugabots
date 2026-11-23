import type {
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
import { conversationFileUrl } from "@/lib/conversation-files.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { useReactions } from "@/lib/reactions.ts";
import { workStateOf } from "@/lib/work-state.ts";
import { NextRunDivider, RunDivider, RunMessage } from "./AutomationRun.tsx";
import { BotStartedThreadLine, threadsStartedBy } from "./BotStartedThreadLine.tsx";
import { ConversationMessages, DaySeparator } from "./ConversationMessages.tsx";
import { chatGroupsOf, latestRunId, messagesIn } from "./chat-items.ts";
import { findAnsweringFace } from "./conversation-layout.ts";
import { queuedBehindReply } from "./queued-messages.ts";
import { RunRow } from "./RunRow.tsx";

/**
 * A chat's items in order: its messages, a run of them at a time, between
 * automation runs and pauses, each day behind a separator, or in an
 * automation's feed, each run. An automation's feed ends with when it runs next.
 */
export function ChatTimeline({
	items,
	details,
	host,
	conversationId,
	user,
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
	/** The bot whose thread it is, as the conversation lists it; none in a project's thread. */
	host: BotParticipant | undefined;
	conversationId: string;
	user: SessionUser;
	/** Everyone here and the project's bots and people. */
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
	const authorLinkOf = useAuthorLinks("Thread");
	const reactions = useReactions(user);
	const reacting = { userId: user.id, onToggle: reactions.toggle, onAdd: reactions.add };
	const automationFeed = details.conversation.kind === "automation_feed";
	const groups = chatGroupsOf(items, automationFeed);
	const shownMessages = messagesIn(items);
	// Found across all the messages, not in each part they're shown in, or each part would bring a face of its own alive.
	const answeringFace = findAnsweringFace(shownMessages, false);
	const queued = queuedBehindReply(shownMessages, details.queuedSince);
	return (
		<>
			{groups.map((group) => (
				<Fragment key={group.key}>
					{group.separated &&
						(automationFeed ? <RunDivider at={group.at} /> : <DaySeparator at={group.at} />)}
					{group.kind === "messages" ? (
						<ConversationMessages
							messages={group.messages}
							participants={mentionable}
							peopleReachingProject={details.peopleReachingProject}
							conversationKind={details.conversation.kind}
							projectId={details.conversation.projectId}
							dividers={false}
							onOpenItem={onOpenItem}
							onOpenFile={onOpenFile}
							onOpenDesktop={onOpenDesktop}
							fileUrlOf={(fileId) => conversationFileUrl(conversationId, fileId)}
							previews={previews}
							approvalCapabilities={details.capabilities}
							queued={queued}
							sending={sending}
							answeringFace={answeringFace}
							viewerWriting={viewerWriting}
							viewerId={user.id}
							namedBotId={host?.id}
							nameColorsFor={conversationId}
							highlightedMessageId={pointedOut}
							authorLinkOf={authorLinkOf}
							onReply={onReply}
							sideLinesOf={(message) => {
								const { author } = message;
								if (author.kind !== "bot") return null;
								return threadsStartedBy(message).map((started) => (
									<BotStartedThreadLine
										key={started.id}
										started={started}
										startedBy={author}
										projectBots={details.projectBots}
									/>
								));
							}}
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
		<RunRow
			automationName={item.automationName}
			triggerKind={item.triggerKind}
			state={workStateOf(
				entries.find((entry) => entry.conversationId === item.conversationId)?.status,
			)}
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

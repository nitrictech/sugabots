import type {
	BotParticipant,
	ChatDetails,
	ChatMessageItem,
	CurrentUser,
	Message,
	Participant,
} from "@sugabots/contracts";
import { Pause } from "lucide-react";
import { Fragment } from "react";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { useReactions } from "@/lib/reactions.ts";
import { workStateOf } from "@/lib/work-state.ts";
import { NextRunDivider, RunDivider, RunMessage } from "./AutomationRun.tsx";
import { BotStartedChatLine, chatsStartedBy } from "./BotStartedChatLine.tsx";
import { ChatMessages, DaySeparator } from "./ChatMessages.tsx";
import { chatGroupsOf, latestRunId, messagesIn } from "./chat-items.ts";
import { findAnsweringFace } from "./chat-layout.ts";
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
	chatId,
	signedIn,
	mentionable,
	sending,
	viewerWriting,
	pointedOut,
	previews,
	onOpenRun,
	onOpenFile,
	onOpenDesktop,
	onReply,
	onJumpToMessage,
}: {
	items: readonly ChatMessageItem[];
	details: ChatDetails;
	/** The bot whose chat it is, as the chat lists it; none in a project's chat. */
	host: BotParticipant | undefined;
	chatId: string;
	signedIn: CurrentUser;
	/** Everyone here and the project's bots and members. */
	mentionable: Participant[];
	/** The viewer's messages still on their way to the API. */
	sending: ReadonlySet<string>;
	/** Whether the viewer has a draft, so a bot's face waiting to answer stays still. */
	viewerWriting: boolean;
	/** A message pointed out for a moment, as one jumped to is. */
	pointedOut: string | undefined;
	/** Whether replies show what they made; off while something is open large beside the chat. */
	previews: boolean;
	/** Opens an automation's run, by its chat, from its row. */
	onOpenRun: (runChatId: string) => void;
	onOpenFile: (fileId: string) => void;
	onOpenDesktop: () => void;
	onReply: (message: Message) => void;
	onJumpToMessage: (messageId: string) => void;
}) {
	const authorLinkOf = useAuthorLinks("Chat");
	const reactions = useReactions(signedIn);
	const reacting = { memberId: signedIn.id, onToggle: reactions.toggle, onAdd: reactions.add };
	const automationFeed = details.chat.kind === "automation_feed";
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
						<ChatMessages
							messages={group.messages}
							participants={mentionable}
							membersReachingProject={details.membersReachingProject}
							chatKind={details.chat.kind}
							projectId={details.chat.projectId}
							dividers={false}
							onOpenFile={onOpenFile}
							onOpenDesktop={onOpenDesktop}
							fileUrlOf={(fileId) => chatFileUrl(chatId, fileId)}
							previews={previews}
							approvalPermissions={details.permissions}
							queued={queued}
							sending={sending}
							answeringFace={answeringFace}
							viewerWriting={viewerWriting}
							viewerId={signedIn.id}
							namedBotId={host?.id}
							nameColorsFor={chatId}
							highlightedMessageId={pointedOut}
							authorLinkOf={authorLinkOf}
							onReply={onReply}
							sideLinesOf={(message) => {
								const { author } = message;
								if (author.kind !== "bot") return null;
								return chatsStartedBy(message).map((started) => (
									<BotStartedChatLine
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
							chatId={chatId}
							latest={details.automation.failed && group.item.id === latestRunId(items)}
							mentionable={mentionable}
						/>
					) : (
						<RunLine item={group.item} onOpenRun={onOpenRun} />
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
	onOpenRun,
}: {
	item: Extract<ChatMessageItem, { kind: "run" }>;
	onOpenRun: (runChatId: string) => void;
}) {
	return (
		<RunRow
			automationName={item.automationName}
			triggerKind={item.triggerKind}
			state={workStateOf(item.state)}
			at={item.createdAt}
			onOpen={() => onOpenRun(item.chatId)}
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

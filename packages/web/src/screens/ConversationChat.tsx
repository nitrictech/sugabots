import type { BotParticipant, Message, SessionUser } from "@sugabots/contracts";
import { quotedPreview } from "@sugabots/contracts";
import { cn } from "cn";
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import {
	directPeopleTitle,
	useConversationHistory,
	useConversationMessages,
	useMarkReadWhileSeen,
	useOptimisticChatItems,
} from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { useConversationDraft, useReplyDraft } from "@/lib/conversation-draft.ts";
import {
	useConversationEvents,
	useConversationNotices,
	usePeopleTyping,
	useTypingSignal,
} from "@/lib/conversation-events.ts";
import { useConversation } from "@/lib/conversations.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import type { AutomationsView } from "./AutomationsStage.tsx";
import { ChatBeside } from "./ChatBeside.tsx";
import type { ChatPlace } from "./ChatHeader.tsx";
import { ChatLog } from "./ChatLog.tsx";
import { ChatTimeline } from "./ChatTimeline.tsx";
import { ConversationComposer } from "./ConversationComposer.tsx";
import { ConversationHeader } from "./ConversationHeader.tsx";
import { ConversationIntro } from "./ConversationIntro.tsx";
import { typersAfter } from "./ConversationMessages.tsx";
import { ConversationNotices } from "./ConversationNotices.tsx";
import { chatItemRevision, mergeChatItems, messagesIn, sendingIds } from "./chat-items.ts";
import { useChatLogPosition } from "./chat-log-position.ts";
import { draftAudience, useChatRecipients } from "./chat-recipients.ts";
import { type AnyConversationPlace, conversationOwner } from "./conversation-place.ts";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { opensBeside, useItemOpening } from "./item-opening.ts";
import { useListedProjectThread } from "./listed-project-thread.ts";
import { mentionableIn } from "./mentions.tsx";
import { useMessageSending } from "./message-sending.ts";
import type { Staged, StagedChange } from "./staged.ts";
import { useThreadDone } from "./thread-done.ts";

/** The narrowest the chat may be dragged beside what is staged large. */
const MIN_STAGED_CHAT_WIDTH_PX = 320;

/**
 * A conversation as a chat: its header, its messages, the composer, and
 * whatever is open beside it.
 */
export function ConversationChat({
	conversationPlace,
	conversationId,
	user,
	itemConversationId,
	focusMessageId,
	place,
	onItemChange,
	staged,
	onStagedChange,
	headerless = false,
	onSent,
	covered = false,
}: {
	/** Where the conversation is: one of a project's threads, one of a bot's, or a direct message. */
	conversationPlace: AnyConversationPlace;
	/** The conversation shown. */
	conversationId: string;
	user: SessionUser;
	itemConversationId?: string;
	/** A message to jump to and point out, such as the mention it was opened from. */
	focusMessageId?: string;
	place: ChatPlace;
	onItemChange: (itemConversationId: string | undefined) => void;
	/** Open large beside the chat, in place of any sidebar. */
	staged?: Staged;
	onStagedChange: StagedChange;
	/** Without its header, as New message shows a conversation under its To field. */
	headerless?: boolean;
	/** Once a message written here has been sent. */
	onSent?: () => void;
	/**
	 * Hidden under something else on the page, as New message's suggestions
	 * cover the conversation under them: the viewer is not looking at it, so
	 * it is neither read nor kept from notifying them.
	 */
	covered?: boolean;
}) {
	const { conversation, project } = conversationPlace;
	const openFile = (fileId: string) => onStagedChange({ kind: "file", fileId });
	const openDesktop = () => onStagedChange({ kind: "desktop" });
	const openAutomations = (view: AutomationsView = { kind: "list" }) =>
		onStagedChange({ kind: "automations", view });
	const messages = useConversationMessages(conversationId);
	const history = useConversationHistory(conversationId);
	const opened = useConversation(conversationId);
	const details = opened.data;
	// A project's threads' drafts are kept by the project; a bot's thread's or a direct message's, by the conversation alone.
	const projectId = project?.id ?? null;
	useConversationEvents(conversationId);
	const notices = useConversationNotices(conversationId);
	const optimistic = useOptimisticChatItems(conversationId);
	const [draft, setDraft] = useConversationDraft(user.id, projectId, conversationId);
	const [replyingTo, setReplyingTo] = useReplyDraft(user.id, projectId, conversationId);
	const attachments = useComposerAttachments(conversationId);
	useTypingSignal(conversationId, draft);
	const peopleTyping = usePeopleTyping(conversationId, user.id);

	const bot = conversation.kind === "botThread" ? conversation.bot : null;
	const headerBox = useRef<HTMLDivElement>(null);
	const messageColumn = useRef<HTMLDivElement>(null);
	// Over the chat while there is room beside its column, else a bar above it.
	// Measured again once the messages are in, as their column is drawn only then.
	const headerCrowded = useHeaderCrowding(headerBox, messageColumn, messages.isSuccess);
	// In a project, the bots people name reply; in a bot's thread its own bot does,
	// asking any other bot named for its help.
	const namedBotsReply = conversation.kind === "projectThread";
	const host = bot
		? details?.participants.find(
				(participant): participant is BotParticipant =>
					participant.kind === "bot" && participant.id === bot.id,
			)
		: undefined;
	const items = mergeChatItems(messages.items, optimistic, details?.messages ?? []);
	const shownMessages = messagesIn(items);

	const openItem = useItemOpening({
		itemConversationId,
		loaded: details !== undefined,
		items,
		owner: conversationOwner(conversationPlace),
		feedOfAutomationId: details?.automation?.id,
		onItemChange,
	});
	const position = useChatLogPosition({
		messages,
		latestItemRevision: chatItemRevision(items.at(-1)),
		shownMessageIds: shownMessages.map((message) => message.id),
		focusMessageId,
	});
	useMarkReadWhileSeen(conversationId, items.at(-1), position.latestInView && !covered);
	const recipients = useChatRecipients({
		userId: user.id,
		projectId,
		conversationId,
		namedBotsReply,
		projectBots: details?.projectBots,
		shownMessages,
		draft,
		setDraft,
		replyingTo,
	});
	const sending = useMessageSending({
		conversationId,
		user,
		draft,
		setDraft,
		replyingTo,
		setReplyingTo,
		attachments,
		recipients,
		scrollToLatest: position.scrollToLatest,
		onSent,
	});
	const threadDone = useThreadDone(conversationId, details);
	const projectThread = useListedProjectThread(
		project,
		conversationId,
		details?.conversation.title,
	);
	// Beside a file or a computer, the chat is as wide as the viewer last dragged it.
	const [chatWidth, setChatWidth] = usePaneWidth("staged-chat");
	const chatColumn = useRef<HTMLDivElement>(null);
	// An automation's feed keeps its bar; a thread's or a direct message's header sits over it while there is room.
	const headerOverChat = !details?.automation && !headerCrowded;

	const header = (
		<ConversationHeader
			conversationPlace={conversationPlace}
			details={details}
			conversationId={conversationId}
			user={user}
			place={place}
			detailsAvailable={!staged}
			projectThreadName={projectThread.name}
			projectThreadToChange={projectThread.toChange}
			done={threadDone.done}
			overChat={headerOverChat}
			onOpenDesktop={openDesktop}
		/>
	);
	if (!details || (bot && !host))
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{!headerless && header}
				{!opened.isPending && (
					<EmptyState title="Could not load this conversation">
						The API did not answer. Reload this page to try again.
					</EmptyState>
				)}
			</div>
		);

	const mentionable = mentionableIn(details);
	function replyTo(message: Message) {
		if (message.author.kind === "automation_trigger") return;
		setReplyingTo({ id: message.id, author: message.author, preview: quotedPreview(message) });
	}
	const itemOpen = opensBeside(itemConversationId, history.entries);
	// A thread's Details float as cards under the header's button; from a tablet up the thread makes way for them.
	const floatingDetails =
		place.kind === "own" &&
		place.detailsOpen &&
		!staged &&
		!itemOpen &&
		conversation.kind !== "directMessage" &&
		!details.automation;

	return (
		// Not positioned on a phone, so a sidebar there covers the chat's header as well as the chat.
		<div className="flex min-h-0 min-w-0 flex-1 md:relative">
			<div
				ref={chatColumn}
				style={
					staged && chatWidth !== undefined
						? ({ "--pane-width": `${chatWidth}px` } as CSSProperties)
						: undefined
				}
				className={cn(
					"relative flex min-w-0 flex-1 flex-col",
					staged && "md:w-conversation-pane md:flex-none md:border-border md:border-r",
				)}
			>
				{staged && (
					<ResizeHandle
						label="Resize the chat"
						pane={chatColumn}
						edge="end"
						min={MIN_STAGED_CHAT_WIDTH_PX}
						onResize={setChatWidth}
					/>
				)}
				{/*
				 * On a phone the header's glass pieces float over the messages, as the
				 * tabs do at the foot, and they scroll on under them. Only the pieces
				 * take a tap; anywhere else reaches the message beneath.
				 */}
				{!headerless && (
					<div
						ref={headerBox}
						className={cn(
							"max-md:pointer-events-none max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-10 max-md:[&_a,&_button]:pointer-events-auto",
							// The chat scrolls up under its header from a tablet up too, as a phone's does.
							headerOverChat &&
								"md:pointer-events-none md:absolute md:inset-x-0 md:top-0 md:z-10 md:[&_a,&_button]:pointer-events-auto",
						)}
					>
						{header}
					</div>
				)}
				<FileDropTarget
					onDropFiles={bot?.model === null ? undefined : attachments.attach}
					className={cn(
						"flex min-h-0 flex-1 flex-col transition-all duration-300 ease-out motion-reduce:transition-none",
						floatingDetails && "md:pr-clear-details",
					)}
				>
					<ChatLog
						position={position}
						messages={messages}
						columnRef={messageColumn}
						underHeader={headerOverChat}
						intro={
							<ConversationIntro
								conversationPlace={conversationPlace}
								projectThreadName={projectThread.name}
								details={details}
							/>
						}
					>
						<ChatTimeline
							items={items}
							details={details}
							host={host}
							bot={bot}
							conversationId={conversationId}
							user={user}
							mentionable={mentionable}
							entries={history.entries}
							sending={sendingIds(optimistic, messages.items, details.messages)}
							viewerWriting={draft.trim() !== ""}
							pointedOut={position.pointedOut}
							previews={!staged}
							onOpenItem={openItem}
							onOpenFile={openFile}
							onOpenDesktop={openDesktop}
							onReply={replyTo}
							onJumpToMessage={position.jumpTo}
						/>
						{position.notFound && (
							<p role="status" className="m-0 px-5 py-2 text-center text-muted-foreground text-xs">
								Could not find the message you opened in this chat.
							</p>
						)}
						<ConversationNotices notices={notices} />
					</ChatLog>
					<ConversationComposer
						bot={bot}
						host={host}
						details={details}
						user={user}
						namedBotsReply={namedBotsReply}
						chatName={chatNameOf(conversation, projectThread.name)}
						draft={draft}
						onDraftChange={setDraft}
						replyingTo={replyingTo}
						onReplyingToChange={setReplyingTo}
						attachments={attachments}
						audience={draftAudience(draft, mentionable, host)}
						recipients={recipients}
						sending={sending}
						doneFailed={threadDone.failed}
						typers={typersAfter(shownMessages, peopleTyping)}
					/>
				</FileDropTarget>
			</div>
			<ChatBeside
				conversationPlace={conversationPlace}
				details={details}
				conversationId={conversationId}
				user={user}
				place={place}
				staged={staged}
				onStagedChange={onStagedChange}
				itemConversationId={itemConversationId}
				entries={history.entries}
				onItemChange={onItemChange}
				onOpenItem={openItem}
				onOpenFile={openFile}
				onOpenAutomations={openAutomations}
				shownMessages={shownMessages}
				projectThreadName={projectThread.name}
				projectThreadToChange={projectThread.toChange}
			/>
		</div>
	);
}

/**
 * Whom a message here goes to while the draft names nobody: the bot, in a bot's
 * thread; the people, in a direct message; or the project's thread, by its name.
 */
function chatNameOf(
	conversation: AnyConversationPlace["conversation"],
	projectThreadName: string,
): string {
	if (conversation.kind === "botThread") return conversation.bot.name;
	if (conversation.kind === "directMessage") return directPeopleTitle(conversation);
	return projectThreadName;
}

/** How close a header's title or buttons may come to the thread's column before the header becomes a bar above it. */
const HEADER_CLEARANCE_PX = 12;

/**
 * Whether a chat's header would overlap its messages if it sat over them:
 * its title reaching into the column from the left, or its buttons from the
 * right. Neither moves sideways when the header becomes a bar, so this does
 * not flip back and forth.
 */
function useHeaderCrowding(
	header: RefObject<HTMLDivElement | null>,
	column: RefObject<HTMLDivElement | null>,
	enabled: boolean,
): boolean {
	const [crowded, setCrowded] = useState(false);
	useLayoutEffect(() => {
		const headerElement = header.current;
		const columnElement = column.current;
		if (!enabled || !headerElement || !columnElement) return;
		const measure = () => setCrowded(headerOverlaps(headerElement, columnElement));
		const observer = new ResizeObserver(measure);
		observer.observe(headerElement);
		observer.observe(columnElement);
		measure();
		return () => observer.disconnect();
	}, [header, column, enabled]);
	return enabled && crowded;
}

function headerOverlaps(header: HTMLElement, column: HTMLElement): boolean {
	const area = column.getBoundingClientRect();
	const title = header.querySelector("[data-header-title]")?.getBoundingClientRect();
	if (title && title.width > 0 && title.right + HEADER_CLEARANCE_PX > area.left) return true;
	const controls = [...header.querySelectorAll("button, a")]
		.filter((control) => !control.closest("[data-header-title]"))
		.map((control) => control.getBoundingClientRect())
		.filter((box) => box.width > 0);
	return controls.some((box) => box.left - HEADER_CLEARANCE_PX < area.right);
}

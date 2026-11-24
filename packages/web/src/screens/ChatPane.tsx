import type { BotParticipant, CurrentUser, Message } from "@sugabots/contracts";
import { quotedPreview } from "@sugabots/contracts";
import { cn } from "cn";
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useChatDraft, useReplyDraft } from "@/lib/chat-draft.ts";
import {
	useChatEvents,
	useChatNotices,
	useMembersTyping,
	useTypingSignal,
} from "@/lib/chat-events.ts";
import { useChat } from "@/lib/chat-query.ts";
import {
	type ChatLocation,
	placeBot,
	useChatMessages,
	useMarkReadWhileSeen,
	useOptimisticChatItems,
} from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { useLeadBot } from "@/lib/resource-owner.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import type { AutomationsView } from "./AutomationsStage.tsx";
import { ChatBeside } from "./ChatBeside.tsx";
import { ChatFooter } from "./ChatFooter.tsx";
import type { ChatPlace } from "./ChatHeader.tsx";
import { ChatIntro } from "./ChatIntro.tsx";
import { ChatKindHeader } from "./ChatKindHeader.tsx";
import { ChatLog } from "./ChatLog.tsx";
import { typersAfter } from "./ChatMessages.tsx";
import { ChatNotices } from "./ChatNotices.tsx";
import { ChatTimeline } from "./ChatTimeline.tsx";
import { chatItemRevision, mergeChatItems, messagesIn, sendingIds } from "./chat-items.ts";
import { leadOf } from "./chat-location.ts";
import { useChatLogPosition } from "./chat-log-position.ts";
import { choosesBotsIn, draftAudience, useChatRecipients } from "./chat-recipients.ts";
import { useChatResolved } from "./chat-resolved.ts";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { useListedProjectChat } from "./listed-project-chat.ts";
import { mentionableIn } from "./mentions.tsx";
import { useMessageSending } from "./message-sending.ts";
import { useRunOpening } from "./run-opening.ts";
import type { Staged, StagedChange } from "./staged.ts";

/** The narrowest the chat may be dragged beside what is staged large. */
const MIN_STAGED_CHAT_WIDTH_PX = 320;

/**
 * A chat on screen: its header, its messages, the composer, and
 * whatever is open beside it.
 */
export function ChatPane({
	chatLocation,
	chatId,
	signedIn,
	focusMessageId,
	place,
	staged,
	onStagedChange,
}: {
	/** Where the chat is: one of a project's chats, or one of a bot's. */
	chatLocation: ChatLocation;
	/** The chat shown. */
	chatId: string;
	signedIn: CurrentUser;
	/** A message to jump to and point out, such as the mention it was opened from. */
	focusMessageId?: string;
	place: ChatPlace;
	/** Open large beside the chat, in place of any sidebar. */
	staged?: Staged;
	onStagedChange: StagedChange;
}) {
	const project = "project" in chatLocation ? chatLocation.project : null;
	const bot = placeBot(chatLocation) ?? null;
	const leadHasModel = useLeadBot(chatLocation)?.model != null;
	const openFile = (fileId: string) => onStagedChange({ kind: "file", fileId });
	const openDesktop = () => onStagedChange({ kind: "desktop" });
	const openAutomations = (view: AutomationsView = { kind: "list" }) =>
		onStagedChange({ kind: "automations", view });
	const messages = useChatMessages(chatId);
	const opened = useChat(chatId);
	const details = opened.data;
	useChatEvents(chatId);
	const notices = useChatNotices(chatId);
	const optimistic = useOptimisticChatItems(chatId);
	const [draft, setDraft] = useChatDraft(signedIn.id, chatId);
	const [replyingTo, setReplyingTo] = useReplyDraft(signedIn.id, chatId);
	const attachments = useComposerAttachments(chatId);
	useTypingSignal(chatId, draft);
	const membersTyping = useMembersTyping(chatId, signedIn.id);

	const headerBox = useRef<HTMLDivElement>(null);
	const messageColumn = useRef<HTMLDivElement>(null);
	// Over the chat while there is room beside its column, else a bar above it.
	// Measured again once the messages are in, as their column is drawn only then.
	const headerCrowded = useHeaderCrowding(headerBox, messageColumn, messages.isSuccess);
	const host = bot
		? details?.participants.find(
				(participant): participant is BotParticipant =>
					participant.kind === "bot" && participant.id === bot.id,
			)
		: undefined;
	const items = mergeChatItems(messages.items, optimistic, details?.messages ?? []);
	const shownMessages = messagesIn(items);

	const openRun = useRunOpening({
		items,
		owner: chatLocation,
		feedOfAutomationId: details?.automation?.id,
	});
	const position = useChatLogPosition({
		messages,
		latestItemRevision: chatItemRevision(items.at(-1)),
		shownMessageIds: shownMessages.map((message) => message.id),
		focusMessageId,
	});
	useMarkReadWhileSeen(chatId, items.at(-1), position.latestInView);
	const recipients = useChatRecipients({
		memberId: signedIn.id,
		chatId,
		choosesBots: choosesBotsIn(details),
		projectBots: details?.projectBots,
		shownMessages,
		draft,
		setDraft,
		replyingTo,
	});
	const sending = useMessageSending({
		chatId,
		signedIn,
		draft,
		setDraft,
		replyingTo,
		setReplyingTo,
		attachments,
		recipients,
		scrollToLatest: position.scrollToLatest,
	});
	const chatResolved = useChatResolved(chatId, details);
	const projectChat = useListedProjectChat(project, chatId, details?.chat.title);
	// Beside a file or a computer, the chat is as wide as the viewer last dragged it.
	const [chatWidth, setChatWidth] = usePaneWidth("staged-chat");
	const chatColumn = useRef<HTMLDivElement>(null);
	// An automation's feed keeps its bar; a chat's header sits over it while there is room.
	const headerOverChat = !details?.automation && !headerCrowded;

	const header = (
		<ChatKindHeader
			chatLocation={chatLocation}
			details={details}
			chatId={chatId}
			place={place}
			detailsAvailable={!staged}
			projectChatName={projectChat.name}
			projectChatToChange={projectChat.toChange}
			resolved={chatResolved.resolved}
			overChat={headerOverChat}
			onOpenDesktop={openDesktop}
		/>
	);
	if (!details || (bot && !host))
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				{!opened.isPending && (
					<EmptyState title="Could not load this chat">
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
	// A chat's Details float as cards under the header's button; from a tablet up the chat makes way for them.
	const floatingDetails =
		place.kind === "own" && place.detailsOpen && !staged && !details.automation;

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
					staged && "md:w-chat-pane md:flex-none md:border-border md:border-r",
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
				<FileDropTarget
					onDropFiles={attachments.attach}
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
						footer={
							<ChatFooter
								chatLocation={chatLocation}
								details={details}
								signedIn={signedIn}
								chatName={bot?.name ?? projectChat.name}
								draft={draft}
								onDraftChange={setDraft}
								replyingTo={replyingTo}
								onReplyingToChange={setReplyingTo}
								attachments={attachments}
								audience={draftAudience({
									draft,
									chatKind: details.chat.kind,
									mentionable,
									projectBots: details.projectBots,
									lead: leadOf(chatLocation, details),
									leadHasModel,
									chosen: recipients.answering,
									replyingTo,
								})}
								recipients={recipients}
								sending={sending}
								resolveFailed={chatResolved.failed}
								typers={typersAfter(shownMessages, membersTyping)}
							/>
						}
						intro={
							<ChatIntro
								chatLocation={chatLocation}
								projectChatName={projectChat.name}
								details={details}
							/>
						}
					>
						<ChatTimeline
							items={items}
							details={details}
							host={host}
							chatId={chatId}
							signedIn={signedIn}
							mentionable={mentionable}
							sending={sendingIds(optimistic, messages.items, details.messages)}
							viewerWriting={draft.trim() !== ""}
							pointedOut={position.pointedOut}
							previews={!staged}
							onOpenRun={openRun}
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
						<ChatNotices notices={notices} />
					</ChatLog>
				</FileDropTarget>
			</div>
			<ChatBeside
				chatLocation={chatLocation}
				details={details}
				chatId={chatId}
				signedIn={signedIn}
				place={place}
				staged={staged}
				onStagedChange={onStagedChange}
				onOpenAutomations={openAutomations}
				shownMessages={shownMessages}
				projectChatName={projectChat.name}
				projectChatToChange={projectChat.toChange}
			/>
		</div>
	);
}

/** How close a header's title or buttons may come to the chat's column before the header becomes a bar above it. */
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

import {
	type Bot,
	type BotParticipant,
	type BotStartedTask,
	botStartedTaskSchema,
	type Channel,
	type ChatHistoryEntry,
	type ChatMessageItem,
	type ConversationDetails,
	type FilePart,
	MESSAGE_MAX_LENGTH,
	type Message,
	mentionedHandles,
	mentionPattern,
	mentionsOnlyPeople,
	type Participant,
	quotedPreview,
	type SessionUser,
	START_TASK_TOOL,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Option, Schema } from "effect";
import { Pause } from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	type RefObject,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { useBots, useModelName } from "@/lib/bots.ts";
import { useChatDraft, useChatReplyDraft, useTakenOffRecipients } from "@/lib/chat-draft.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import {
	type ConversationPlaceKind,
	chatItemCreatedAt,
	type DirectPeople,
	directPeopleNames,
	directPeopleTitle,
	isOneToOne,
	useChatHistory,
	useChatList,
	useChatMessages,
	useMarkReadWhileSeen,
	useOptimisticChatItems,
	useSendChatMessage,
	useSetDone,
} from "@/lib/chats.ts";
import { isFileGoneRefusal, useComposerAttachments } from "@/lib/composer-attachments.ts";
import {
	useConversationEvents,
	useConversationNotices,
	usePeopleTyping,
	useTypingSignal,
} from "@/lib/conversation-events.ts";
import { useConversation } from "@/lib/conversations.ts";
import { keepFootInView, useFollowContentGrowth, useSettledAtLatest } from "@/lib/follow-latest.ts";
import type { TasksTab } from "@/lib/links.ts";
import { automationFeedLink, botSettingsLink, conversationLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { useReactions } from "@/lib/reactions.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ChannelConversationTile } from "@/shell/ChannelConversationTile.tsx";
import { DirectPeopleAvatar } from "@/shell/DirectMessages.tsx";
import { Alert } from "@/ui/alert.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { AutomationPanel } from "./AutomationPanel.tsx";
import { NextRunDivider, RunDivider, RunMessage } from "./AutomationRun.tsx";
import { AutomationsStage, type AutomationsView } from "./AutomationsStage.tsx";
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import {
	type BackTo,
	ChatHeader,
	type ChatPlace,
	type HeaderPlace,
	PeopleChatHeader,
	PHONE_FACE_SIZE_PX,
} from "./ChatHeader.tsx";
import { ChatMenu } from "./ChatMenu.tsx";
import { ConnectionsNotice } from "./ConnectionsNotice.tsx";
import { ConversationMessages, DaySeparator, typersAfter } from "./ConversationMessages.tsx";
import { ConversationNotices } from "./ConversationNotices.tsx";
import { findAnsweringFace, startsNewDay } from "./conversation-layout.ts";
import { DesktopStage } from "./DesktopViewer.tsx";
import {
	ChannelDetails,
	type ConversationContents,
	DetailsSidebar,
	PeopleDetails,
} from "./DetailsSidebar.tsx";
import { DirectMembersButton } from "./DirectMembers.tsx";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { FileStage } from "./Files.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import { botsNamed, groupMentionsBy, mentionableIn } from "./mentions.tsx";
import { queuedBehindReply } from "./queued-messages.ts";
import { SideConversationLine } from "./SideConversationLine.tsx";
import { TasksStage } from "./TasksStage.tsx";
import { anyoneTyping, TypingIndicator } from "./TypingIndicator.tsx";

/**
 * How close to the foot of the log still counts as at the latest message, both
 * for following new messages and for marking the chat read: about two lines, so
 * a small nudge up is not taken as scrolling away.
 */
const LATEST_IN_VIEW_TOLERANCE_PX = 48;

/** Shown when marking a task done, or reopening it, did not save. */
const DONE_FAILURE_MESSAGE = "This task was not marked done or reopened. Try again.";
/** Names the bots a channel message asks, as "Ada, Bea and Cy". */
const BOT_LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * What is open large beside a chat: a file, at its current version when
 * `version` is absent, the bot's computer's desktop, the bot's automations,
 * at the view of them that is open, or the bot's tasks, at the tab open.
 */
export type Staged =
	| { kind: "file"; fileId: string; version?: number }
	| { kind: "desktop" }
	| { kind: "automations"; view: AutomationsView }
	| { kind: "tasks"; tab: TasksTab };

/** Opens `staged` large beside a chat, or closes it as a `Stage` asks, as `how` says; see `CloseStage`. */
export type StagedChange = (staged: Staged | undefined, how?: { replace: boolean }) => void;

export function ConversationChat({
	conversation,
	channel,
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
	/** Which kind of conversation it is, and its bot when it has one. */
	conversation: ConversationPlaceKind;
	/** The channel it is in; null for a bot's task or a direct message, which are in none. */
	channel: Channel | null;
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
	/** Hidden under something else on the page, so nothing in it counts as seen. */
	covered?: boolean;
}) {
	const openFile = (fileId: string) => onStagedChange({ kind: "file", fileId });
	const openDesktop = () => onStagedChange({ kind: "desktop" });
	const openAutomations = (view: AutomationsView = { kind: "list" }) =>
		onStagedChange({ kind: "automations", view });
	const messages = useChatMessages(conversationId);
	const history = useChatHistory(conversationId);
	const opened = useConversation(conversationId);
	// Drafts are kept by the channel they are written in; elsewhere, by the conversation alone.
	const channelId = channel?.id ?? null;
	const authorLinkOf = useAuthorLinks();
	useConversationEvents(conversationId);
	const notices = useConversationNotices(conversationId);
	const optimistic = useOptimisticChatItems(conversationId);
	const send = useSendChatMessage(conversationId, user);
	const setDone = useSetDone(conversationId);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const { leaveFor } = useLeave();
	const [startError, setStartError] = useState<string>();
	const reactions = useReactions(user);
	const reacting = { userId: user.id, onToggle: reactions.toggle, onAdd: reactions.add };
	const [draft, setDraft] = useChatDraft(user.id, channelId, conversationId);
	const [replyingTo, setReplyingTo] = useChatReplyDraft(user.id, channelId, conversationId);
	const attachments = useComposerAttachments(conversationId);
	useTypingSignal(conversationId, draft);
	const peopleTyping = usePeopleTyping(conversationId, user.id);
	const viewport = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const previousItemConversationId = useRef<string | undefined>(undefined);
	const positionedAtLatest = useRef(false);
	const followingLatest = useRef(true);
	const lastScrollTop = useRef(Number.NEGATIVE_INFINITY);
	// Where the log was last scrolled to. `followingLatest` is the intent to stay
	// at the latest message, which can be set before the scroll that gets there.
	const [latestInView, setLatestInView] = useState(true);
	const details = opened.data;
	const bot = conversation.kind === "botConversation" ? conversation.bot : null;
	const isChannelConversation = conversation.kind === "channelConversation";
	// In a channel, the bots people name reply; in a task its own bot does,
	// asking any other bot named for its help.
	const namedBotsReply = isChannelConversation;
	// A direct message between people goes by the others' names.
	const peopleName =
		conversation.kind === "directMessage" ? directPeopleTitle(conversation) : undefined;
	const host = bot
		? details?.participants.find(
				(participant): participant is BotParticipant =>
					participant.kind === "bot" && participant.id === bot.id,
			)
		: undefined;
	const entries = history.entries;
	const selectedEntry = itemConversationId
		? entries.find((entry) => entry.conversationId === itemConversationId)
		: undefined;
	const items = mergeChatItems(messages.items, optimistic, details?.messages ?? []);
	const sending = sendingIds(optimistic, messages.items, details?.messages ?? []);
	const automationFeed = details?.conversation.kind === "automation_feed";
	const groups = chatGroupsOf(items, automationFeed);
	const latestItemRevision = chatItemRevision(items.at(-1));
	const newest = items.at(-1);
	useMarkReadWhileSeen(conversationId, newest, latestInView && !covered);
	const shownMessages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
	// Found across all the messages, not in each part they're shown in, or each part would bring a face of its own alive.
	const answeringFace = findAnsweringFace(shownMessages, false);
	// The automation runs the messages shown are the results of, by the run's conversation.
	const runsResulting = new Map(
		shownMessages.flatMap((message) =>
			message.automationResultOf
				? [[message.automationResultOf.conversationId, message.automationResultOf]]
				: [],
		),
	);
	// Every run shown here, as a result or a row of its own, by the run's conversation.
	const runConversationIds = new Set([
		...runsResulting.keys(),
		...items.flatMap((item) => (item.kind === "run" ? [item.conversationId] : [])),
	]);
	const itemActivityAt = new Map(
		entries.map((entry) => [entry.conversationId, entry.latestActivityAt]),
	);
	const queued = queuedBehindReply(shownMessages, details?.queuedSince ?? null);
	// Where named bots reply, the bots the person's last message went to stay
	// addressed until they take them off: talking to a bot is a conversation,
	// not a mention every time. Taking one off lasts until they send again.
	const channelBots = namedBotsReply ? (details?.channelBots ?? []) : [];
	const lastOwnMessage = namedBotsReply
		? shownMessages.findLast(
				(message) => message.author.kind === "person" && message.author.id === user.id,
			)
		: undefined;
	const [takenOff, setTakenOff] = useTakenOffRecipients(user.id, channelId, conversationId);
	const takenOffIds = takenOff.after === lastOwnMessage?.id ? takenOff.botIds : [];
	const named = botsNamed(draft, channelBots);
	const repliedToBot = channelBots.find(
		(member): member is BotParticipant =>
			member.kind === "bot" &&
			replyingTo?.author.kind === "bot" &&
			member.id === replyingTo.author.id,
	);
	const addressedBots = (lastOwnMessage ? botsAddressedBy(lastOwnMessage, channelBots) : []).filter(
		(bot) =>
			!takenOffIds.includes(bot.id) &&
			bot.id !== repliedToBot?.id &&
			!named.some((one) => one.id === bot.id),
	);
	function takeOff(botIds: readonly string[]) {
		setTakenOff({ after: lastOwnMessage?.id, botIds: [...takenOffIds, ...botIds] });
	}
	// Taken off wherever it came from: named in the draft, or addressed by the last message.
	function removeRecipient(bot: BotParticipant) {
		setDraft((current) => withoutMention(current, bot.handle));
		takeOff([bot.id]);
	}
	const answeringBots = [...named, ...addressedBots, ...(repliedToBot ? [repliedToBot] : [])];
	// Beside a file or a computer, the chat is as wide as the viewer last dragged it.
	const [chatWidth, setChatWidth] = usePaneWidth("staged-chat");
	const chatColumn = useRef<HTMLDivElement>(null);
	// The model of the bot a message here goes to: the one named in the channel, else this task's own.
	const { bots } = useBots();
	const answeringModel = useModelName(
		(namedBotsReply ? bots?.find((one) => one.id === answeringBots[0]?.id)?.model : bot?.model) ??
			null,
	);
	// Everyone here and the channel's bots, not yourself. Naming a bot has it reply where
	// people talk among themselves, and asks this chat's own bot to bring it in elsewhere.
	const composerMentionable = useMemo(
		() =>
			details
				? [
						...mentionableIn(details).filter((candidate) => candidate.id !== user.id),
						...groupMentionsBy(
							{ kind: "person", id: user.id },
							details.members,
							details.conversation.kind,
						),
					]
				: [],
		[details, user.id],
	);

	useLayoutEffect(() => {
		if (!details) return;
		if (itemConversationId && !previousItemConversationId.current) {
			opener.current = document.activeElement as HTMLElement;
		}
		if (!itemConversationId && previousItemConversationId.current)
			requestAnimationFrame(() => opener.current?.focus());
		previousItemConversationId.current = itemConversationId;
	}, [details, itemConversationId]);

	useLayoutEffect(() => {
		if (
			latestItemRevision &&
			viewport.current &&
			(!positionedAtLatest.current || followingLatest.current)
		) {
			viewport.current.scrollTop = viewport.current.scrollHeight;
			positionedAtLatest.current = true;
		}
	}, [latestItemRevision]);

	const [jumpTarget, jumpTo] = useJumpTarget(focusMessageId);
	const jump = useJumpToMessage({
		target: jumpTarget,
		shown: shownMessages.some((message) => message.id === jumpTarget?.messageId),
		viewport,
		older:
			!messages.isSuccess || messages.isFetchingNextPage
				? "loading"
				: messages.hasNextPage
					? "available"
					: "none",
		loadOlder,
		pagesLoaded: messages.data?.pages.length ?? 0,
		onJumped: () => {
			// Reading back from here: new messages no longer pull the chat to its foot.
			followingLatest.current = false;
			positionedAtLatest.current = true;
		},
	});

	useFollowContentGrowth(viewport, followingLatest);
	// Hidden on a phone until it is at the latest, rather than showing its top for a moment first.
	const settledAtLatest = useSettledAtLatest(viewport, followingLatest, !messages.isPending);
	const attachViewport = useCallback((element: HTMLDivElement | null) => {
		viewport.current = element;
		if (!element) return;
		const stopKeepingFoot = keepFootInView(element);
		return () => {
			stopKeepingFoot();
			viewport.current = null;
		};
	}, []);

	async function submit() {
		if (send.isPending) return;
		setStartError(undefined);
		const message = draft.trim();
		// The bots the message goes to but does not name are named at its start,
		// so it shows who it was for, and they are asked as any named bot is.
		const unnamed = answeringBots.filter((bot) => !named.includes(bot));
		const addressedMessage =
			unnamed.length > 0
				? `${unnamed.map((bot) => `@${bot.handle}`).join(" ")} ${message}`
				: message;
		if (addressedMessage.length > MESSAGE_MAX_LENGTH) {
			setStartError(
				"With the bots it's sent to named, this message is too long. Shorten it a little.",
			);
			return;
		}
		const files = attachments.takeForSending(draft);
		if (!files) return;
		const submitted = draft;
		const answered = replyingTo;
		setDraft("");
		setReplyingTo(undefined);
		followingLatest.current = true;
		try {
			const sent = send.mutateAsync({
				id: uuidv4(),
				message: addressedMessage,
				replyTo: answered,
				files: files.parts,
			});
			scrollToLatest();
			await sent;
			scrollToLatest();
			onSent?.();
		} catch (failure) {
			setDraft((current) => (current === "" ? submitted : current));
			setReplyingTo((current) => current ?? answered);
			files.putBack(failure);
		}
	}

	/** Opens a task a bot started from its reply, with whichever bot it is with. */
	function openStartedTask(started: BotStartedTask) {
		const other = started.withBotId
			? details?.channelBots.find((member) => member.id === started.withBotId)
			: undefined;
		const withBot = other ?? bot;
		if (!withBot) return;
		void navigate(conversationLink({ bot: withBot, conversationId: started.id }));
	}

	function replyTo(message: Message) {
		if (message.author.kind === "automation_trigger") return;
		setReplyingTo({ id: message.id, author: message.author, preview: quotedPreview(message) });
	}

	function scrollToLatest() {
		followingLatest.current = true;
		requestAnimationFrame(() => {
			if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
		});
	}

	async function loadOlder() {
		const element = viewport.current;
		const height = element?.scrollHeight ?? 0;
		const top = element?.scrollTop ?? 0;
		await messages.fetchNextPage();
		requestAnimationFrame(() => {
			if (element) element.scrollTop = top + element.scrollHeight - height;
		});
	}

	function openItem(nextItemConversationId: string) {
		// A run's own conversation is never opened beside a chat: its automation's
		// feed opens in its place, unless that is the chat already open.
		if (runConversationIds.has(nextItemConversationId)) {
			const run = runsResulting.get(nextItemConversationId);
			if (run && bot && run.automationId !== details?.automation?.id) {
				void navigate(automationFeedLink(bot, run.automationId));
			}
			return;
		}
		opener.current = document.activeElement as HTMLElement;
		onItemChange(nextItemConversationId);
	}

	const title = details?.conversation.title;
	const chats = useChatList(channel?.slug).data?.chats;
	const listedChat = chats?.find((chat) => chat.conversation.id === conversationId)?.conversation;
	// An archived thread is not listed, so it goes by the name it was archived with.
	const channelConversationName = listedChat?.title ?? title ?? "";
	// Only a task is ever done: not a channel's conversation, nor an automation's feed.
	const done =
		details?.conversation.kind === "task"
			? {
					isDone: details.conversation.doneAt !== null,
					onChange: (to: boolean) =>
						setDone.mutateAsync(to).then(
							() => true,
							() => false,
						),
				}
			: undefined;
	// Back returns to where the conversation lives: its bot, its channel, or the direct messages.
	const back: BackTo = bot
		? { to: "bot", bot }
		: channel
			? { to: "channel", channel }
			: { to: "directMessages" };
	const headerPlace: HeaderPlace =
		place.kind === "away"
			? { back: place.back, trailing: place.trailing }
			: {
					back,
					trailing: place.trailing,
					parent: place.parent,
					details: staged
						? undefined
						: { open: place.detailsOpen, onChange: place.onDetailsChange },
				};
	const header =
		conversation.kind === "botConversation" && details?.automation ? (
			<PeopleChatHeader
				{...headerPlace}
				title={title ?? details.conversation.title}
				mark="automation"
			/>
		) : conversation.kind === "botConversation" ? (
			<ChatHeader
				{...headerPlace}
				bot={conversation.bot}
				title={title}
				done={done}
				conversationId={conversationId}
				onOpenDesktop={openDesktop}
				onOpenAutomations={() => openAutomations()}
			/>
		) : conversation.kind === "channelConversation" ? (
			<PeopleChatHeader
				{...headerPlace}
				title={channelConversationName}
				menu={
					listedChat &&
					channel?.permissions.rename && (
						<ChatMenu
							channel={channel}
							conversationId={conversationId}
							name={channelConversationName}
							archivable={!listedChat.main}
						/>
					)
				}
			/>
		) : conversation.kind === "directMessage" ? (
			<PeopleChatHeader
				{...headerPlace}
				// Nothing opens beside a direct message: who is in a group drops down from its members' count.
				details={undefined}
				title={peopleName ?? ""}
				face={<DirectPeopleAvatar {...conversation} size={PHONE_FACE_SIZE_PX} />}
				detail={
					isOneToOne(conversation) ? undefined : (
						<DirectMembersButton direct={conversation} user={user} />
					)
				}
			/>
		) : null;
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
	// A bot's conversation goes to its bot unless the message mentions only people.
	const draftHandles = mentionedHandles(draft);
	const draftMentions = mentionable.filter((member) => draftHandles.includes(member.handle));
	const botStaysOut =
		host !== undefined &&
		mentionsOnlyPeople(draftHandles, {
			botHandles: handlesOf(mentionable, "bot"),
			peopleHandles: handlesOf(mentionable, "person"),
		});
	const composerLabel =
		botStaysOut && draftMentions.length > 0
			? `Message ${listNames(draftMentions.map((person) => person.name))}`
			: details.automation && bot
				? `Message ${bot.name} about this automation`
				: `Message ${bot?.name ?? peopleName ?? (isChannelConversation ? channelConversationName : (channel?.name ?? channelConversationName))}`;
	const typers = typersAfter(shownMessages, peopleTyping);
	const contents: ConversationContents = {
		participants: details.participants,
		files: shownMessages.flatMap((message) =>
			message.parts.filter((part): part is FilePart => part.type === "file"),
		),
		fileUrlOf: (fileId) => chatFileUrl(conversationId, fileId),
	};
	const askedForHelp = draftMentions.filter(
		(member) => member.kind === "bot" && member.id !== host?.id,
	);
	const hint = namedBotsReply
		? answeringBots.length > 0
			? `${BOT_LIST.format(answeringBots.map((bot) => bot.name))} will reply here.`
			: "Mention a bot to have it reply here."
		: botStaysOut
			? `${host.name} won't reply.`
			: host && askedForHelp.length > 0
				? `${host.name} will ask ${BOT_LIST.format(askedForHelp.map((bot) => bot.name))} for help.`
				: undefined;

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
						min={320}
						onResize={setChatWidth}
					/>
				)}
				{/*
				 * On a phone the header's glass pieces float over the messages, as the
				 * tabs do at the foot, and they scroll on under them. Only the pieces
				 * take a tap; anywhere else reaches the message beneath.
				 */}
				{!headerless && (
					<div className="max-md:pointer-events-none max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-10 max-md:[&_a,&_button]:pointer-events-auto">
						{header}
					</div>
				)}
				<FileDropTarget
					onDropFiles={bot?.model === null ? undefined : attachments.attach}
					className="flex min-h-0 flex-1 flex-col"
				>
					<div
						ref={attachViewport}
						role="log"
						aria-label="Chat messages"
						onScroll={(event) => {
							const element = event.currentTarget;
							const atFoot =
								element.scrollHeight - element.scrollTop - element.clientHeight <
								LATEST_IN_VIEW_TOLERANCE_PX;
							if (atFoot) followingLatest.current = true;
							else if (element.scrollTop < lastScrollTop.current) followingLatest.current = false;
							lastScrollTop.current = element.scrollTop;
							setLatestInView(atFoot);
						}}
						className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-4 max-md:pt-safe-offset-16"
					>
						{/* Anchored to the bottom, so a short chat sits just above the composer. */}
						<div
							className={cn(
								"flex min-h-full w-full flex-col justify-end",
								!settledAtLatest && "max-md:invisible",
							)}
						>
							{messages.isError && (
								<div className="px-5">
									<Alert>Messages could not be loaded. Reload this page to try again.</Alert>
								</div>
							)}
							{messages.hasNextPage && (
								<Button
									variant="link"
									size="bare"
									className="self-center"
									disabled={messages.isFetchingNextPage}
									onClick={() => void loadOlder()}
								>
									{messages.isFetchingNextPage ? "Loading…" : "Load older messages"}
								</Button>
							)}
							{messages.isSuccess &&
								!messages.hasNextPage &&
								(isChannelConversation && channel ? (
									<ChannelConversationIntro
										channel={channel}
										name={channelConversationName}
										details={details}
									/>
								) : conversation.kind === "directMessage" ? (
									<DirectIntro {...conversation} />
								) : details.conversation.kind === "automation_feed" ? (
									bot && <AutomationIntro title={details.conversation.title} bot={bot} />
								) : (
									bot && <ChatIntro bot={bot} title={title} />
								))}
							{groups.map((group) => (
								<Fragment key={group.key}>
									{group.separated &&
										(automationFeed ? (
											<RunDivider at={group.at} />
										) : (
											<DaySeparator at={group.at} />
										))}
									{group.kind === "messages" ? (
										<ConversationMessages
											messages={group.messages}
											host={host}
											isRunning={false}
											participants={mentionable}
											members={details.members}
											conversationKind={details.conversation.kind}
											dividers={false}
											onOpenItem={openItem}
											onOpenFile={openFile}
											onOpenDesktop={openDesktop}
											fileUrlOf={(fileId) => chatFileUrl(conversationId, fileId)}
											previews={!staged}
											approvalCapabilities={details.capabilities}
											queued={queued}
											sending={sending}
											showsTyping={false}
											answeringFace={answeringFace}
											viewerWriting={draft.trim() !== ""}
											highlightedMessageId={jump.pointedOut}
											itemActivityAt={itemActivityAt}
											authorLinkOf={authorLinkOf}
											onReply={replyTo}
											inAutomationFeed={automationFeed}
											sideLinesOf={(message) =>
												tasksStartedBy(message).map((started) => (
													<BotStartedTaskLine
														key={started.id}
														started={started}
														startedBy={message.author}
														channelBots={details?.channelBots ?? []}
														onOpen={() => openStartedTask(started)}
													/>
												))
											}
											onJumpToMessage={jumpTo}
											reacting={reacting}
										/>
									) : group.item.kind === "automation_paused" ? (
										<PausedLine at={group.item.createdAt} />
									) : details.automation && host && bot ? (
										<RunMessage
											item={group.item}
											bot={host}
											automation={details.automation}
											conversationId={conversationId}
											latest={details.automation.failed && group.item.id === latestRunId(items)}
											mentionable={mentionable}
										/>
									) : (
										<ActivityLine item={group.item} entries={entries} onOpenItem={openItem} />
									)}
								</Fragment>
							))}
							{details.automation && <NextRunDivider automation={details.automation} />}
							{jump.notFound && (
								<p
									role="status"
									className="m-0 px-5 py-2 text-center text-muted-foreground text-xs"
								>
									Could not find the message you opened in this chat.
								</p>
							)}
							<ConversationNotices notices={notices} />
						</div>
					</div>
					<div className="shrink-0 px-4 max-md:pb-tab-bar md:px-5">
						{bot?.model === null ? (
							<BotNotSetUp bot={bot} />
						) : (
							<ChatComposer
								label={composerLabel}
								model={botStaysOut ? undefined : (answeringModel ?? undefined)}
								value={draft}
								onValueChange={setDraft}
								onSubmit={submit}
								submitLabel="Send message"
								sending={send.isPending}
								error={
									startError ??
									(send.isError
										? sendFailureMessage(send.error)
										: setDone.isError
											? DONE_FAILURE_MESSAGE
											: undefined)
								}
								className="w-full"
								mentionable={composerMentionable}
								replyingTo={
									replyingTo && { message: replyingTo, onCancel: () => setReplyingTo(undefined) }
								}
								addressed={{
									// Those the draft names too, so the row shows everyone the message goes to.
									bots: [...addressedBots, ...named],
									onRemove: removeRecipient,
									onClearInherited: () => takeOff(addressedBots.map((bot) => bot.id)),
								}}
								attachments={attachments}
								notice={bot && <ConnectionsNotice bot={bot} />}
							/>
						)}
						{/*
						 * Always its height, so nothing moves as somebody starts or stops typing.
						 * On a phone, with the tabs straight under it, it takes room only while
						 * there is something to say, and is a small gap above the tabs otherwise.
						 */}
						<div className="flex h-6.5 items-center max-md:h-auto max-md:min-h-2 max-md:[&>*]:py-1">
							{anyoneTyping(typers) ? (
								<TypingIndicator typers={typers} className="px-1" />
							) : (
								hint && <p className="m-0 px-1 text-xs text-muted-foreground">{hint}</p>
							)}
						</div>
					</div>
				</FileDropTarget>
			</div>
			{/* One beside the chat at a time: what is staged, else an item, else Details. */}
			{staged?.kind === "file" && (channel || bot) ? (
				<FileStage
					owner={channel ? { channel } : { bot: bot as Bot }}
					fileId={staged.fileId}
					version={staged.version}
					onVersionChange={(version) => onStagedChange({ ...staged, version })}
					// Leaving in its place, as a deleted one is left, goes back to the chat when that is behind.
					onClose={(how) =>
						how?.replace
							? leaveFor(
									(page) => page.pathname === pathname && page.search.file === undefined,
									() => onStagedChange(undefined, how),
								)
							: onStagedChange(undefined)
					}
				/>
			) : staged?.kind === "desktop" && bot ? (
				<DesktopStage
					conversationId={details.conversation.id}
					bot={bot}
					mayUse={bot.permissions.useDesktop}
					onClose={() => onStagedChange(undefined)}
				/>
			) : staged?.kind === "tasks" && bot ? (
				<TasksStage
					bot={bot}
					tab={staged.tab}
					onTabChange={(tab) => onStagedChange({ kind: "tasks", tab }, { replace: true })}
					onClose={() => onStagedChange(undefined)}
				/>
			) : staged?.kind === "automations" && bot ? (
				<AutomationsStage
					bot={bot}
					user={user}
					view={staged.view}
					onViewChange={openAutomations}
					onStagedChange={onStagedChange}
					onClose={() => onStagedChange(undefined)}
				/>
			) : itemConversationId &&
				conversation.kind !== "directMessage" &&
				selectedEntry?.kind !== "run" ? (
				<ItemPanel
					conversationId={conversationId}
					chatBotId={bot?.id}
					itemConversationId={itemConversationId}
					entry={selectedEntry}
					history={entries}
					frame={{ kind: "sidebar", onClose: () => onItemChange(undefined) }}
					onOpenItem={openItem}
					onOpenFile={openFile}
				/>
			) : (
				place.kind === "own" &&
				place.detailsOpen &&
				conversation.kind !== "directMessage" &&
				(isChannelConversation ? (
					<ChannelDetails
						name={channelConversationName}
						people={details.members.length}
						bots={details.channelBots.filter((member) => member.kind === "bot").length}
						channel={
							listedChat && channel?.permissions.rename
								? {
										channel,
										conversationId,
										name: channelConversationName,
										archivable: !listedChat.main,
									}
								: undefined
						}
						user={user}
						contents={contents}
						onClose={() => place.onDetailsChange(false)}
					/>
				) : details.automation && bot ? (
					<AutomationPanel
						bot={bot}
						conversationId={conversationId}
						standing={details.automation}
						onClose={() => place.onDetailsChange(false)}
					/>
				) : bot ? (
					<DetailsSidebar
						bot={bot}
						conversationId={details.conversation.id}
						user={user}
						contents={contents}
						onOpenAutomations={(automationId) =>
							openAutomations(automationId ? { kind: "automation", automationId } : undefined)
						}
						onClose={() => place.onDetailsChange(false)}
					/>
				) : (
					<PeopleDetails
						user={user}
						contents={contents}
						onClose={() => place.onDetailsChange(false)}
					/>
				))
			)}
		</div>
	);
}

/**
 * Under the composer when a message is not sent. A file that was gone comes
 * back as a failed chip to retry; any other refusal says what to change.
 */
function sendFailureMessage(failure: unknown): string {
	if (isFileGoneRefusal(failure)) {
		return "Message not sent. Some files were no longer there. Retry them to send.";
	}
	if (isApiFailure(failure) && failure._tag === "BadRequest") {
		return `Message not sent. ${failure.message}.`;
	}
	return "Message not sent. Your draft is still here.";
}

type ChatActivityItem = Extract<ChatMessageItem, { kind: "run" | "automation_paused" }>;

/** An automation run, as a row among the messages. */
function ActivityLine({
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
type ChatMessage = Extract<ChatMessageItem, { kind: "message" }>["message"];

type ChatGroup = { key: string; at: string; separated: boolean } & (
	| { kind: "messages"; messages: ChatMessage[] }
	| { kind: "activity"; item: ChatActivityItem }
);

/**
 * The chat's items as they are drawn: runs of messages together, so one
 * author's messages in a row read as a run, and each collaboration or automation
 * row on its own. A new day starts a new group behind a separator.
 */
function chatGroupsOf(items: readonly ChatMessageItem[], byRun: boolean): ChatGroup[] {
	const groups: ChatGroup[] = [];
	let previousAt: string | undefined;
	for (const item of items) {
		const at = item.kind === "message" ? item.message.createdAt : item.createdAt;
		// An automation's feed is marked where each run starts; any other, where each day does.
		const separated = byRun ? startsAutomationRun(item) : startsNewDay(previousAt, at);
		previousAt = at;
		const last = groups.at(-1);
		if (item.kind === "message") {
			if (last?.kind === "messages" && !separated) {
				last.messages.push(item.message);
				continue;
			}
			groups.push({
				kind: "messages",
				key: item.message.id,
				at,
				separated,
				messages: [item.message],
			});
			continue;
		}
		groups.push({ kind: "activity", key: item.id, at, separated, item });
	}
	return groups;
}

function mergeChatItems(
	pageItems: ChatMessageItem[],
	optimistic: ChatMessageItem[],
	liveMessages: NonNullable<ReturnType<typeof useConversation>["data"]>["messages"],
): ChatMessageItem[] {
	const items = new Map<string, ChatMessageItem>();
	for (const item of [...pageItems, ...optimistic]) {
		items.set(chatItemId(item), item);
	}
	for (const message of liveMessages)
		items.set(`message:${message.id}`, { kind: "message", message });
	return [...items.values()].sort((left, right) =>
		chatItemCreatedAt(left).localeCompare(chatItemCreatedAt(right)),
	);
}

/** The messages shown as sent that the API has not yet been heard to have. */
function sendingIds(
	optimistic: ChatMessageItem[],
	pageItems: ChatMessageItem[],
	liveMessages: readonly Message[],
): ReadonlySet<string> {
	const saved = new Set([
		...pageItems.flatMap((item) => (item.kind === "message" ? [item.message.id] : [])),
		...liveMessages.map(({ id }) => id),
	]);
	return new Set(
		optimistic.flatMap((item) =>
			item.kind === "message" && !saved.has(item.message.id) ? [item.message.id] : [],
		),
	);
}

function chatItemId(item: ChatMessageItem): string {
	return item.kind === "message" ? `message:${item.message.id}` : `${item.kind}:${item.id}`;
}

function chatItemRevision(item: ChatMessageItem | undefined): string {
	if (!item) return "";
	if (item.kind !== "message") return `${item.kind}:${item.id}`;
	return `${item.message.id}:${item.message.status}:${item.message.content}:${JSON.stringify(item.message.parts)}`;
}

/** How many older pages a jump to a message loads looking for it, before it gives up. */
const MAX_PAGES_TO_FIND = 10;
/** How long a message jumped to stays pointed out. */
const POINTED_OUT_MS = 2000;

/** One request to go to a message. Asking again for the same message is a new request. */
interface JumpTarget {
	messageId: string;
}

/**
 * The message to go to: the one the chat was opened at, until a reply's quote
 * asks for another, and again whenever the chat is opened at a new one.
 */
function useJumpTarget(
	focusMessageId: string | undefined,
): [JumpTarget | undefined, (messageId: string) => void] {
	const [target, setTarget] = useState(() => jumpTargetOf(focusMessageId));
	const [openedAt, setOpenedAt] = useState(focusMessageId);
	if (focusMessageId !== openedAt) {
		setOpenedAt(focusMessageId);
		setTarget(jumpTargetOf(focusMessageId));
	}
	return [target, (messageId) => setTarget({ messageId })];
}

function jumpTargetOf(messageId: string | undefined): JumpTarget | undefined {
	return messageId ? { messageId } : undefined;
}

/**
 * Jumps to the target's message once it is shown, loading older pages until it
 * is, up to a limit, then centres it, moves the focus to it, and points it out
 * for a moment. Each target is jumped to once. Returns the message pointed out,
 * if any, and whether the search gave up without finding it.
 */
function useJumpToMessage({
	target,
	shown,
	viewport,
	older,
	loadOlder,
	pagesLoaded,
	onJumped,
}: {
	target: JumpTarget | undefined;
	/** Whether the message is among those loaded. */
	shown: boolean;
	viewport: RefObject<HTMLDivElement | null>;
	/** Whether an older page can be loaded now, is on its way, or there is none. */
	older: "available" | "loading" | "none";
	loadOlder: () => Promise<void>;
	pagesLoaded: number;
	onJumped: () => void;
}): { pointedOut: string | undefined; notFound: boolean } {
	const jumped = useRef<JumpTarget>(undefined);
	const [pointedOut, setPointedOut] = useState<string>();
	const loadOlderPage = useEffectEvent(() => void loadOlder());
	const jumpedTo = useEffectEvent(onJumped);
	const searchedEnough = pagesLoaded >= MAX_PAGES_TO_FIND;
	useEffect(() => {
		if (!target || jumped.current === target) return;
		if (!shown) {
			if (older === "available" && !searchedEnough) loadOlderPage();
			return;
		}
		const row = [
			...(viewport.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
		].find((candidate) => candidate.dataset.messageId === target.messageId);
		if (!row) return;
		jumped.current = target;
		// In the next frame, after the scroll event from the chat's first move to its
		// foot, which would otherwise say the chat is following its latest again.
		requestAnimationFrame(() => {
			if (viewport.current) centreIn(viewport.current, row);
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
			jumpedTo();
		});
		setPointedOut(target.messageId);
	}, [target, shown, viewport, older, searchedEnough]);
	useEffect(() => {
		if (!pointedOut) return;
		const fade = setTimeout(() => setPointedOut(undefined), POINTED_OUT_MS);
		return () => clearTimeout(fade);
	}, [pointedOut]);
	const notFound =
		target !== undefined && !shown && older !== "loading" && (older === "none" || searchedEnough);
	return { pointedOut, notFound };
}

/**
 * Scrolls `scroller` alone so `row` sits in its middle. `scrollIntoView` would
 * also scroll every box around it, such as the app's frame, which is clipped
 * rather than meant to scroll, and leave the whole page shifted up.
 */
function centreIn(scroller: HTMLElement, row: HTMLElement) {
	const frame = scroller.getBoundingClientRect();
	const box = row.getBoundingClientRect();
	scroller.scrollTop += box.top - frame.top - (frame.height - box.height) / 2;
}

/** The newest automation run in `items`, which is the one that can be tried again. */
function latestRunId(items: readonly ChatMessageItem[]): string | undefined {
	return items.findLast((item) => item.kind === "run")?.id;
}

/** In an automation's feed: that it paused itself after failing twice in a row, and when. */
function PausedLine({ at }: { at: string }) {
	return (
		<p className="m-0 flex items-center gap-2 px-5 py-2 pl-17.5 font-medium text-xs text-muted-foreground">
			<Pause aria-hidden size={14} strokeWidth={2} className="shrink-0" />
			Paused after two failed runs in a row.
			<span className="font-normal text-xs text-subtle-foreground">
				{formatListTime(new Date(at), new Date())}
			</span>
		</p>
	);
}

/**
 * A task a bot started with `start_task` in its reply, shown from the call,
 * under the reply that names it.
 */
function BotStartedTaskLine({
	started,
	startedBy,
	channelBots,
	onOpen,
}: {
	started: BotStartedTask;
	startedBy: Message["author"];
	channelBots: readonly Participant[];
	onOpen: () => void;
}) {
	const otherBot =
		started.withBotId && channelBots.find((member) => member.id === started.withBotId);
	const faces = [
		...(startedBy.kind === "automation_trigger" ? [] : [startedBy]),
		...(otherBot ? [otherBot] : []),
	];
	return (
		<SideConversationLine
			faces={faces}
			label={started.title}
			description={`Open task: ${started.title}`}
			onOpen={onOpen}
		/>
	);
}

const decodeStartTaskOutput = Schema.decodeUnknownOption(
	Schema.Union([
		Schema.Struct({ task: botStartedTaskSchema }),
		// What the tool answered under its name before tasks were called that, which earlier calls record.
		Schema.Struct({ thread: botStartedTaskSchema }),
	]),
);

/** The tool's name before tasks were called that, which earlier calls record. */
const START_THREAD_TOOL = "start_thread";

/** The tasks a bot's message started with `start_task`, in the order it started them. */
function tasksStartedBy(message: Message): BotStartedTask[] {
	return message.parts.flatMap((part) => {
		if (part.type !== "tool_call") return [];
		if (part.tool !== START_TASK_TOOL && part.tool !== START_THREAD_TOOL) return [];
		if (part.status !== "completed") return [];
		return Option.match(decodeStartTaskOutput(part.output), {
			onNone: () => [],
			onSome: (output) => ["task" in output ? output.task : output.thread],
		});
	});
}

/** The top of an automation's feed: what the automation is called, and the bot that runs it. */
function AutomationIntro({ title, bot }: { title: string; bot: Bot }) {
	return (
		<div className="flex flex-col gap-1.5 px-5 pt-6 pb-4">
			<h2 className="m-0 font-bold text-xl text-foreground leading-tight">{title}</h2>
			<p className="m-0 text-xs text-muted-foreground">Runs as {bot.name}. Each run posts here.</p>
		</div>
	);
}

/** The top of a channel's conversation: how many are in it, and what it is for. */
function ChannelConversationIntro({
	channel,
	name,
	details,
}: {
	channel: Channel;
	name: string;
	details: ConversationDetails;
}) {
	const people = details.members.length;
	const bots = details.channelBots.filter((member) => member.kind === "bot").length;
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<ChannelConversationTile color={channel.color} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-normal">{name}</h2>
			<p className="m-0 max-w-140 text-sm text-muted-foreground leading-normal">
				This is the start of {name}, with {countOf(people, "person", "people")} and{" "}
				{countOf(bots, "bot", "bots")}. Talk here, and mention a bot to have it reply.
			</p>
		</div>
	);
}

/**
 * The top of a task, once there is nothing older to load: what it is about,
 * with whom, or, before it has a name, whom it is with.
 */
function ChatIntro({ bot, title }: { bot: Bot; title: string | undefined }) {
	// A task is about something, so its name leads and the bot is beside it, smaller.
	if (title) {
		return (
			<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
				<h2 className="m-0 font-bold text-2xl text-foreground leading-tight tracking-normal text-balance max-md:text-xl">
					{title}
				</h2>
				<p className="m-0 flex max-w-140 items-center gap-2 text-sm text-muted-foreground leading-normal">
					<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={20} />
					With {bot.name}
				</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-normal">{bot.name}</h2>
			<p className="m-0 max-w-140 text-sm text-muted-foreground leading-normal">
				This is the start of your task with {bot.name}.{bot.description && ` ${bot.description}`}
			</p>
		</div>
	);
}

/**
 * The top of a direct message between people, once there is nothing older to
 * load: whom it is with, and that only the people in it see it.
 */
function DirectIntro(direct: DirectPeople) {
	const name = directPeopleTitle(direct);
	const description =
		direct.people.length === 0
			? "They have left the workspace, so they won't see anything new here."
			: isOneToOne(direct)
				? `This is the start of your direct messages with ${name}. Only the two of you can see them.`
				: `This is a private conversation between ${everyoneNamed(directPeopleNames(direct))}. Only the people here can see it.`;
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<DirectPeopleAvatar {...direct} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-tight text-balance">
				{name}
			</h2>
			<p className="m-0 max-w-140 text-sm text-muted-foreground leading-normal">{description}</p>
		</div>
	);
}

/** Everyone in a direct message, `others` then you, each named, however many: "A, B and you". */
function everyoneNamed(others: readonly string[]): string {
	return `${others.join(", ")} and you`;
}

/**
 * Stands in for the composer while the bot has no model. The API refuses the
 * message anyway, so offering a box to type into would only lose the draft.
 * Only somebody who may edit the bot is offered the way to fix it.
 */
function BotNotSetUp({ bot }: { bot: Bot }) {
	const backToChat = useBackToHere("Chat");
	return (
		<p className="mx-auto m-0 w-full max-w-190 rounded-2xl border border-border-strong px-4 py-3.5 text-sm text-muted-foreground leading-relaxed">
			{bot.name} has no model yet, so it cannot answer.{" "}
			{bot.permissions.update ? (
				<>
					<Link
						{...botSettingsLink(bot)}
						state={backToChat}
						className={buttonStyles({ variant: "link", size: "bare" })}
					>
						Choose a model
					</Link>{" "}
					to start chatting.
				</>
			) : (
				"Somebody who can change this bot chooses its model."
			)}
		</p>
	);
}

/** Whether `item` is where a run starts in an automation's feed: its result, or the run itself when it posted none. */
function startsAutomationRun(item: ChatMessageItem): boolean {
	return item.kind === "run" || (item.kind === "message" && !!item.message.automationResultOf);
}

/** The handles of those in `participants` who are bots (`"bot"`) or people (`"person"`). */
function handlesOf(participants: readonly Participant[], kind: Participant["kind"]): Set<string> {
	return new Set(participants.filter((one) => one.kind === kind).map((one) => one.handle));
}

/** The bots among `channelBots` that `message` went to: those it names, and the one it replied to. */
function botsAddressedBy(message: Message, channelBots: readonly Participant[]): BotParticipant[] {
	const named = botsNamed(message.content, channelBots);
	const repliedTo = message.replyTo?.author;
	const replied =
		repliedTo?.kind === "bot" && !named.some((bot) => bot.id === repliedTo.id)
			? channelBots.filter(
					(member): member is BotParticipant => member.kind === "bot" && member.id === repliedTo.id,
				)
			: [];
	return [...named, ...replied];
}

/** `draft` with its mentions of `handle` taken out, each with the space after it. */
function withoutMention(draft: string, handle: string): string {
	return draft.replace(new RegExp(`${mentionPattern(handle)} ?`, "gi"), "");
}

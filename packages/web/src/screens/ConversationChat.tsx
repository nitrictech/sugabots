import {
	type Agent,
	type AgentParticipant,
	type ChatHistoryEntry,
	type ChatMessageItem,
	type FilePart,
	type Message,
	mentionedHandles,
	messageAuthorName,
	type Pod,
	quotedPreview,
	type SessionUser,
	type ThreadDetails,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
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
import { useAgents, useModelName } from "@/lib/agents.ts";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { useChatDraft, useChatReplyDraft } from "@/lib/chat-draft.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import {
	type ConversationKind,
	chatItemCreatedAt,
	THREAD_NOT_STARTED,
	useChatHistory,
	useChatList,
	useChatMessages,
	useMarkReadWhileSeen,
	useOptimisticChatItems,
	useSendChatMessage,
	useSetDone,
	useThreadFrom,
	useThreadStarter,
} from "@/lib/chats.ts";
import { isFileGoneRefusal, useComposerAttachments } from "@/lib/composer-attachments.ts";
import { keepFootInView, useFollowContentGrowth, useSettledAtLatest } from "@/lib/follow-latest.ts";
import { agentSettingsLink, conversationLink, routineThreadLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { useReactions } from "@/lib/reactions.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import {
	usePeopleTyping,
	useThreadEvents,
	useThreadNotices,
	useTypingSignal,
} from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PodChatTile } from "@/shell/PodChatTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { ArtifactStage } from "./Artifacts.tsx";
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import {
	type BackTo,
	ChatHeader,
	type ChatPlace,
	type HeaderPlace,
	PeopleChatHeader,
} from "./ChatHeader.tsx";
import { ChatMenu } from "./ChatMenu.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import { DesktopStage } from "./DesktopViewer.tsx";
import {
	ChannelDetails,
	DetailsSidebar,
	PeopleDetails,
	type ThreadContents,
} from "./DetailsSidebar.tsx";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { firstBotNamed, mentionableIn, textWithMentions } from "./mentions.tsx";
import { queuedBehindReply } from "./queued-messages.ts";
import { RoutinePanel } from "./RoutinePanel.tsx";
import { NextRunDivider, RunDivider, RunMessage } from "./RoutineRun.tsx";
import { SideThreadLine } from "./SideThreadLine.tsx";
import {
	DaySeparator,
	startsNewDay,
	ThreadConversation,
	typersAfter,
} from "./ThreadConversation.tsx";
import { ThreadNotices } from "./ThreadNotices.tsx";
import { anyoneTyping, TypingIndicator } from "./TypingIndicator.tsx";

/**
 * How close to the foot of the log still counts as at the latest message, both
 * for following new messages and for marking the chat read: about two lines, so
 * a small nudge up is not taken as scrolling away.
 */
const LATEST_IN_VIEW_TOLERANCE_PX = 48;

/** Shown when marking a thread done, or reopening it, did not save. */
const DONE_FAILURE_MESSAGE = "This thread was not marked done or reopened. Try again.";

/**
 * What is open large beside a chat: an artifact, at its current version when
 * `version` is absent, or the bot's sandbox desktop.
 */
export type Staged =
	| { kind: "artifact"; artifactId: string; version?: number }
	| { kind: "desktop" };

/** Opens `staged` large beside a chat, or closes it as a `Stage` asks, as `how` says; see `CloseStage`. */
export type StagedChange = (staged: Staged | undefined, how?: { replace: boolean }) => void;

export function ConversationChat({
	conversation,
	pod,
	conversationId,
	user,
	threadId,
	focusMessageId,
	place,
	onThreadChange,
	staged,
	onStagedChange,
}: {
	/** Which kind of conversation it is, and its bot when it has one. */
	conversation: ConversationKind;
	pod: Pod;
	/** The conversation shown. */
	conversationId: string;
	user: SessionUser;
	threadId?: string;
	/** A message to jump to and point out, such as the mention it was opened from. */
	focusMessageId?: string;
	place: ChatPlace;
	onThreadChange: (threadId: string | undefined) => void;
	/** Open large beside the chat, in place of any sidebar. */
	staged?: Staged;
	onStagedChange: StagedChange;
}) {
	const openArtifact = (artifactId: string) => onStagedChange({ kind: "artifact", artifactId });
	const openDesktop = () => onStagedChange({ kind: "desktop" });
	const messages = useChatMessages(conversationId);
	const history = useChatHistory(conversationId);
	const mainThread = useThread(conversationId);
	const authorLinkOf = useAuthorLinks(pod.id);
	useThreadEvents(conversationId);
	const notices = useThreadNotices(conversationId);
	const optimistic = useOptimisticChatItems(conversationId);
	const send = useSendChatMessage(conversationId, user);
	const setDone = useSetDone(conversationId);
	const threadFrom = useThreadFrom(conversationId);
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const { leaveFor } = useLeave();
	const [startError, setStartError] = useState<string>();
	const reactions = useReactions(user);
	const reacting = { userId: user.id, onToggle: reactions.toggle, onAdd: reactions.add };
	const [draft, setDraft] = useChatDraft(user.id, pod.id, conversationId);
	const [replyingTo, setReplyingTo] = useChatReplyDraft(user.id, pod.id, conversationId);
	const attachments = useComposerAttachments(conversationId);
	const threads = useThreadStarter(conversationId, attachments);
	useTypingSignal(conversationId, draft);
	const peopleTyping = usePeopleTyping(conversationId, user.id);
	const viewport = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const previousThreadId = useRef<string | undefined>(undefined);
	const positionedAtLatest = useRef(false);
	const followingLatest = useRef(true);
	const lastScrollTop = useRef(Number.NEGATIVE_INFINITY);
	// Where the log was last scrolled to. `followingLatest` is the intent to stay
	// at the latest message, which can be set before the scroll that gets there.
	const [latestInView, setLatestInView] = useState(true);
	const details = mainThread.data;
	const agent =
		conversation.kind === "botThread" || conversation.kind === "botChannel"
			? conversation.agent
			: null;
	const isPodChat = conversation.kind === "podChat";
	const host = agent
		? details?.participants.find(
				(participant): participant is AgentParticipant =>
					participant.kind === "agent" && participant.id === agent.id,
			)
		: undefined;
	const entries = history.entries;
	const selectedEntry = threadId ? entries.find((entry) => entry.threadId === threadId) : undefined;
	const items = mergeChatItems(messages.items, optimistic, details?.messages ?? []);
	const sending = sendingIds(optimistic, messages.items, details?.messages ?? []);
	const routineFeed = details?.thread.type === "routine_feed";
	const groups = chatGroupsOf(items, routineFeed);
	const startedThreads = threadsByMessage(items);
	const latestItemRevision = chatItemRevision(items.at(-1));
	const newest = items.at(-1);
	useMarkReadWhileSeen(conversationId, newest, latestInView);
	const shownMessages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
	// The routine runs the messages shown are the results of, by the run's thread.
	const runsResulting = new Map(
		shownMessages.flatMap((message) =>
			message.routineResultOf ? [[message.routineResultOf.threadId, message.routineResultOf]] : [],
		),
	);
	// Every run shown here, as a result or a row of its own, by the run's thread.
	const runThreadIds = new Set([
		...runsResulting.keys(),
		...items.flatMap((item) => (item.kind === "routine" ? [item.threadId] : [])),
	]);
	const threadActivityAt = new Map(
		entries.map((entry) => [entry.threadId, entry.latestActivityAt]),
	);
	const queued = queuedBehindReply(shownMessages, details?.queuedSince ?? null);
	const threadWith = isPodChat && details ? firstBotNamed(draft, details.crew) : undefined;
	// Beside an artifact or a computer, the chat is as wide as the viewer last dragged it.
	const [chatWidth, setChatWidth] = usePaneWidth("staged-chat");
	const chatColumn = useRef<HTMLDivElement>(null);
	// The model of the bot a message here goes to: the one named in the pod's chat, else this chat's own.
	const { agents } = useAgents();
	const answeringModel = useModelName(
		(isPodChat ? agents?.find((one) => one.id === threadWith?.id)?.model : agent?.model) ?? null,
	);
	// The people here and this chat's own bot, not yourself; the pod's other bots are not
	// offered, except in the pod's chat, where naming one starts a thread with it.
	const composerMentionable = useMemo(
		() =>
			details
				? mentionableIn(details).filter(
						(candidate) =>
							candidate.id !== user.id &&
							(candidate.kind === "person" || isPodChat || candidate.id === host?.id),
					)
				: [],
		[details, user.id, isPodChat, host?.id],
	);

	useLayoutEffect(() => {
		if (!details) return;
		if (threadId && !previousThreadId.current) {
			opener.current = document.activeElement as HTMLElement;
		}
		if (!threadId && previousThreadId.current) requestAnimationFrame(() => opener.current?.focus());
		previousThreadId.current = threadId;
	}, [details, threadId]);

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
		if (send.isPending || threads.isPending) return;
		setStartError(undefined);
		if (threadWith) {
			await startThreadWith(threadWith);
			return;
		}
		const files = attachments.takeForSending(draft);
		if (!files) return;
		const message = draft.trim();
		const submitted = draft;
		const answering = replyingTo;
		setDraft("");
		setReplyingTo(undefined);
		followingLatest.current = true;
		try {
			const sent = send.mutateAsync({
				id: uuidv4(),
				message,
				replyTo: answering,
				files: files.parts,
			});
			scrollToLatest();
			await sent;
			scrollToLatest();
		} catch (failure) {
			setDraft((current) => (current === "" ? submitted : current));
			setReplyingTo((current) => current ?? answering);
			files.putBack(failure);
		}
	}

	/** Sends the draft as the first message of a thread with `bot`, staying in the pod's chat. */
	async function startThreadWith(bot: AgentParticipant) {
		const submitted = draft;
		const answering = replyingTo;
		setDraft("");
		setReplyingTo(undefined);
		const started = await threads.start(submitted, {
			hostAgentId: bot.id,
			replyTo: answering?.id,
		});
		if (started.outcome === "started") return;
		setDraft((current) => (current === "" ? submitted : current));
		setReplyingTo((current) => current ?? answering);
		if (started.outcome === "refused") setStartError(THREAD_NOT_STARTED);
	}

	/** Opens a thread started from a message here in its own place. */
	function openPodThread(threadId: string) {
		void navigate(conversationLink({ pod, conversationId: threadId }));
	}

	/**
	 * Starts a thread from `message`, with this channel's bot if it is one, or
	 * opens the one it has; a routine's result opens its routine instead.
	 */
	async function threadFromMessage(message: Message) {
		if (message.routineResultOf) {
			openThread(message.routineResultOf.threadId);
			return;
		}
		try {
			const thread = await threadFrom.mutateAsync(message.id);
			await navigate(conversationLink({ pod, conversationId: thread.id }));
		} catch {
			setStartError("The thread was not started. Try again.");
		}
	}

	function replyTo(message: Message) {
		if (message.author.kind === "routine_trigger") return;
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

	function openThread(nextThreadId: string) {
		// A run's own thread is never opened beside a chat: its routine's thread
		// opens in its place, unless that is the chat already open.
		if (runThreadIds.has(nextThreadId)) {
			const run = runsResulting.get(nextThreadId);
			if (run && run.routineId !== details?.routine?.id) {
				void navigate(routineThreadLink(pod, run.routineId));
			}
			return;
		}
		opener.current = document.activeElement as HTMLElement;
		onThreadChange(nextThreadId);
	}

	const title = details?.thread.title;
	const chats = useChatList(pod.slug).data?.chats;
	const listedChat = chats?.find((chat) => chat.conversation.id === conversationId)?.conversation;
	// The channel a thread between people was started from, which its header names it as in.
	const startedIn = chats?.find((chat) => chat.conversation.id === details?.thread.parentThreadId)
		?.conversation.title;
	// An archived chat is not listed, so it goes by the name it was archived with.
	const podChatName = listedChat?.title ?? title ?? "";
	// A bot's channel goes by the bot's name, and is kept going rather than marked done;
	// in a Personal pod it is the person's own with their bot.
	const ongoing = conversation.kind === "botChannel";
	const direct = ongoing && pod.kind === "personal";
	// Only a conversation is ever done: not the pod's chat, nor a routine's thread.
	const done =
		details?.thread.type === "conversation" && !ongoing
			? {
					isDone: details.thread.doneAt !== null,
					onChange: (to: boolean) =>
						setDone.mutateAsync(to).then(
							() => true,
							() => false,
						),
				}
			: undefined;
	// Back from a thread returns to where it lives: its bot's chat, or the channel it was started from.
	const parentChannelId = details?.thread.parentThreadId;
	const back: BackTo =
		conversation.kind === "botThread" && !details?.routine
			? { to: "bot", pod, agent: conversation.agent }
			: startedIn !== undefined && parentChannelId
				? { to: "channel", pod, conversationId: parentChannelId, name: `#${startedIn}` }
				: { to: "pod", pod };
	const headerPlace: HeaderPlace =
		place.kind === "away"
			? { back: place.back, trailing: place.trailing }
			: {
					back,
					details: staged
						? undefined
						: { open: place.detailsOpen, onChange: place.onDetailsChange },
				};
	const header =
		conversation.kind === "botThread" && details?.routine ? (
			<PeopleChatHeader {...headerPlace} title={title ?? details.thread.title} mark="routine" />
		) : conversation.kind === "botThread" || conversation.kind === "botChannel" ? (
			<ChatHeader
				{...headerPlace}
				agent={conversation.agent}
				title={ongoing ? undefined : title}
				done={done}
				conversationId={conversationId}
				onOpenDesktop={openDesktop}
			/>
		) : conversation.kind === "podChat" ? (
			<PeopleChatHeader
				{...headerPlace}
				title={podChatName}
				menu={
					listedChat &&
					pod.permissions.rename && (
						<ChatMenu
							pod={pod}
							conversationId={conversationId}
							name={podChatName}
							archivable={!listedChat.main}
						/>
					)
				}
			/>
		) : (
			<PeopleChatHeader
				{...headerPlace}
				title={title ?? ""}
				done={done}
				within={startedIn === undefined ? pod.name : `#${startedIn}`}
			/>
		);
	if (!details || (agent && !host))
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				{!mainThread.isPending && (
					<EmptyState title="Could not load this conversation">
						The API did not answer. Reload this page to try again.
					</EmptyState>
				)}
			</div>
		);

	const mentionable = mentionableIn(details);
	// A bot's thread goes to its bot unless the message mentions only people.
	const draftHandles = mentionedHandles(draft);
	const draftMentions = mentionable.filter((member) => draftHandles.includes(member.handle));
	const botStaysOut =
		host !== undefined &&
		draftHandles.length > 0 &&
		!draftMentions.some((member) => member.kind === "agent");
	const composerLabel =
		botStaysOut && draftMentions.length > 0
			? `Message ${listNames(draftMentions.map((person) => person.name))}`
			: details.routine && agent
				? `Message ${agent.name} about this routine`
				: `Message ${agent?.name ?? (isPodChat ? podChatName : pod.name)}`;
	const typers = typersAfter(shownMessages, peopleTyping);
	const contents: ThreadContents = {
		participants: details.participants,
		files: shownMessages.flatMap((message) =>
			message.parts.filter((part): part is FilePart => part.type === "file"),
		),
		fileUrlOf: (fileId) => chatFileUrl(conversationId, fileId),
	};
	const hint = isPodChat
		? threadWith
			? `Sending starts a thread with ${threadWith.name}.`
			: "Mention a bot to start a thread."
		: botStaysOut
			? `${host.name} won't reply.`
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
					staged &&
						"md:w-[clamp(320px,var(--pane-width,440px),calc(100%_-_360px))] md:flex-none md:border-border md:border-r",
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
				 * On a phone, the header's glass controls float over the messages,
				 * which scroll on under them, so the chat has the whole height. Only
				 * the controls take a tap; anywhere else reaches the message beneath.
				 */}
				<div className="max-md:pointer-events-none max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-10 max-md:[&_a,&_button]:pointer-events-auto">
					{header}
				</div>
				<FileDropTarget
					onDropFiles={agent?.model === null ? undefined : attachments.attach}
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
						className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-4 max-md:pt-[124px]"
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
								(details.thread.parentThreadId ? (
									<ThreadIntro details={details} pod={pod} />
								) : isPodChat ? (
									<PodChatIntro pod={pod} name={podChatName} details={details} />
								) : details.thread.type === "routine_feed" ? (
									agent && <RoutineIntro title={details.thread.title} agent={agent} />
								) : (
									agent && (
										<ChatIntro
											agent={agent}
											place={
												direct
													? { kind: "personal" }
													: conversation.kind === "botChannel"
														? { kind: "channel" }
														: { kind: "thread", title }
											}
										/>
									)
								))}
							{groups.map((group) => (
								<Fragment key={group.key}>
									{group.separated &&
										(routineFeed ? <RunDivider at={group.at} /> : <DaySeparator at={group.at} />)}
									{group.kind === "messages" ? (
										<ThreadConversation
											messages={group.messages}
											host={host}
											isRunning={false}
											participants={mentionable}
											dividers={false}
											onOpenThread={openThread}
											onOpenArtifact={openArtifact}
											onOpenDesktop={openDesktop}
											fileUrlOf={(fileId) => chatFileUrl(conversationId, fileId)}
											previews={!staged}
											podId={pod.id}
											approvalCapabilities={details.capabilities}
											queued={queued}
											sending={sending}
											showsTyping={false}
											highlightedMessageId={jump.pointedOut}
											threadActivityAt={threadActivityAt}
											authorLinkOf={authorLinkOf}
											onReply={replyTo}
											onStartThread={
												isPodChat || conversation.kind === "botChannel"
													? threadFromMessage
													: undefined
											}
											inRoutineThread={routineFeed}
											threadLinesOf={(message) =>
												startedThreads
													.get(message.id)
													?.map((thread) => (
														<ThreadLine
															key={thread.id}
															item={thread}
															startedBy={message.author}
															onOpen={() => openPodThread(thread.threadId)}
														/>
													))
											}
											onJumpToMessage={jumpTo}
											reacting={reacting}
										/>
									) : group.item.kind === "thread" ? (
										<div className="px-5 py-0.5 pl-[70px]">
											<ThreadLine
												item={group.item}
												startedBy={undefined}
												onOpen={openPodThread.bind(null, group.item.threadId)}
											/>
										</div>
									) : group.item.kind === "routine_paused" ? (
										<PausedLine at={group.item.createdAt} />
									) : group.item.kind === "routine" && details.routine && host ? (
										<RunMessage
											item={group.item}
											agent={host}
											pod={pod}
											routine={details.routine}
											conversationId={conversationId}
											latest={details.routine.failed && group.item.id === latestRunId(items)}
											mentionable={mentionable}
										/>
									) : (
										<ActivityLine item={group.item} entries={entries} onOpenThread={openThread} />
									)}
								</Fragment>
							))}
							{details.routine && <NextRunDivider routine={details.routine} />}
							{jump.notFound && (
								<p
									role="status"
									className="m-0 px-5 py-2 text-center text-muted-foreground text-sm"
								>
									Could not find the message you opened in this chat.
								</p>
							)}
							<ThreadNotices notices={notices} />
						</div>
					</div>
					<div className="shrink-0 px-4 max-md:pb-[var(--tab-bar-space,0px)] md:px-5">
						{agent?.model === null ? (
							<AgentNotSetUp agent={agent} pod={pod} />
						) : (
							<ChatComposer
								label={composerLabel}
								model={botStaysOut ? undefined : (answeringModel ?? undefined)}
								value={draft}
								onValueChange={setDraft}
								onSubmit={submit}
								submitLabel="Send message"
								sending={send.isPending || threads.isPending}
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
								attachments={attachments}
							/>
						)}
						{/*
						 * Always its height, so nothing moves as somebody starts or stops typing.
						 * On a phone, with the tabs straight under it, it takes room only while
						 * there is something to say, and is a small gap above the tabs otherwise.
						 */}
						<div className="flex h-[26px] items-center max-md:h-auto max-md:min-h-2 max-md:[&>*]:py-1">
							{anyoneTyping(typers) ? (
								<TypingIndicator typers={typers} className="px-1" />
							) : (
								hint && <p className="m-0 px-1 text-[12.5px] text-muted-foreground">{hint}</p>
							)}
						</div>
					</div>
				</FileDropTarget>
			</div>
			{/* One beside the chat at a time: what is staged, else a thread, else Details. */}
			{staged?.kind === "artifact" ? (
				<ArtifactStage
					pod={pod}
					artifactId={staged.artifactId}
					version={staged.version}
					onVersionChange={(version) => onStagedChange({ ...staged, version })}
					// Leaving in its place, as a deleted one is left, goes back to the chat when that is behind.
					onClose={(how) =>
						how?.replace
							? leaveFor(
									(page) => page.pathname === pathname && page.search.artifact === undefined,
									() => onStagedChange(undefined, how),
								)
							: onStagedChange(undefined)
					}
				/>
			) : staged?.kind === "desktop" && agent ? (
				<DesktopStage
					threadId={details.thread.id}
					agent={agent}
					pod={pod}
					mayUse={pod.permissions.useDesktops}
					onClose={() => onStagedChange(undefined)}
				/>
			) : threadId && agent && selectedEntry?.type !== "routine" ? (
				<ChatThreadPanel
					conversationId={conversationId}
					chatAgentId={agent.id}
					threadId={threadId}
					entry={selectedEntry}
					history={entries}
					frame={{ kind: "sidebar", onClose: () => onThreadChange(undefined) }}
					onOpenThread={openThread}
					onOpenArtifact={openArtifact}
				/>
			) : (
				place.kind === "own" &&
				place.detailsOpen &&
				(isPodChat ? (
					<ChannelDetails
						name={podChatName}
						people={details.members.length}
						bots={details.crew.filter((member) => member.kind === "agent").length}
						channel={
							listedChat && pod.permissions.rename
								? { pod, conversationId, name: podChatName, archivable: !listedChat.main }
								: undefined
						}
						user={user}
						contents={contents}
						onClose={() => place.onDetailsChange(false)}
					/>
				) : details.routine && agent ? (
					<RoutinePanel
						agent={agent}
						pod={pod}
						conversationId={conversationId}
						standing={details.routine}
						onClose={() => place.onDetailsChange(false)}
					/>
				) : agent ? (
					<DetailsSidebar
						agent={agent}
						pod={pod}
						threadId={details.thread.id}
						user={user}
						contents={contents}
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

type ChatActivityItem = Extract<ChatMessageItem, { kind: "routine" | "thread" | "routine_paused" }>;

/** A routine run as a row among the messages. */
function ActivityLine({
	item,
	entries,
	onOpenThread,
}: {
	item: ChatActivityItem;
	/** The threads opened beside the chat, where how its run stands is read. */
	entries: readonly ChatHistoryEntry[];
	onOpenThread: (threadId: string) => void;
}) {
	if (item.kind !== "routine") return null;
	const state = activityStateOf(entries.find((entry) => entry.threadId === item.threadId));
	return (
		<ChatActivityRow
			type="routine"
			routineName={item.routineName}
			triggerKind={item.triggerKind}
			state={state}
			at={item.createdAt}
			onOpen={() => onOpenThread(item.threadId)}
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
 * author's messages in a row read as a run, and each collaboration or routine
 * row on its own. A new day starts a new group behind a separator.
 */
function chatGroupsOf(items: readonly ChatMessageItem[], byRun: boolean): ChatGroup[] {
	const groups: ChatGroup[] = [];
	let previousAt: string | undefined;
	// A thread is drawn under the message it was started from, when that message is here.
	const underTheirMessages = new Set(
		[...threadsByMessage(items).values()].flat().map((thread) => thread.id),
	);
	for (const item of items.filter(
		(one) => one.kind !== "thread" || !underTheirMessages.has(one.id),
	)) {
		const at = item.kind === "message" ? item.message.createdAt : item.createdAt;
		// A routine's thread is marked where each run starts; any other, where each day does.
		const separated = byRun ? startsRun(item) : startsNewDay(previousAt, at);
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
	liveMessages: NonNullable<ReturnType<typeof useThread>["data"]>["messages"],
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

/** The newest routine run in `items`, which is the one that can be tried again. */
function latestRunId(items: readonly ChatMessageItem[]): string | undefined {
	return items.findLast((item) => item.kind === "routine")?.id;
}

/** In a routine's thread: that it paused itself after failing twice in a row, and when. */
function PausedLine({ at }: { at: string }) {
	return (
		<p className="m-0 flex items-center gap-2 px-5 py-2 pl-[70px] font-medium text-[13.5px] text-muted-foreground">
			<Pause aria-hidden size={14} strokeWidth={2} className="shrink-0" />
			Paused after two failed runs in a row.
			<span className="font-normal text-[12px] text-subtle-foreground">
				{formatListTime(new Date(at), new Date())}
			</span>
		</p>
	);
}

/**
 * A thread started from a message in the pod's chat, hanging off that
 * message, drawn as a collaboration is: the faces of who started it and its
 * bot, how many replies it has, its name, and when it last moved; or, before
 * any reply, its name. Dots follow while its bot is answering.
 */
function ThreadLine({
	item,
	startedBy,
	onOpen,
}: {
	item: ChatThreadItem;
	startedBy: Message["author"] | undefined;
	onOpen: () => void;
}) {
	// A thread opened from its own bot's message would otherwise show that bot twice.
	const faces = [
		...(startedBy && startedBy.kind !== "routine_trigger" && startedBy.id !== item.agent?.id
			? [startedBy]
			: []),
		...(item.agent ? [item.agent] : []),
	];
	const replied = item.replies > 0;
	return (
		<SideThreadLine
			faces={faces}
			label={replied ? countOf(item.replies, "reply", "replies") : item.title}
			detail={replied ? item.title : undefined}
			description={`Open thread: ${item.title}`}
			lastActivityAt={item.lastReplyAt ?? undefined}
			status={item.working ? "working" : undefined}
			onOpen={onOpen}
		/>
	);
}

type ChatThreadItem = Extract<ChatMessageItem, { kind: "thread" }>;

/** The threads in `items` started from a message among them, by that message's id. */
function threadsByMessage(items: readonly ChatMessageItem[]): Map<string, ChatThreadItem[]> {
	const messageIds = new Set(
		items.flatMap((item) => (item.kind === "message" ? [item.message.id] : [])),
	);
	const byMessage = new Map<string, ChatThreadItem[]>();
	for (const item of items) {
		if (item.kind !== "thread" || !item.originMessageId) continue;
		if (!messageIds.has(item.originMessageId)) continue;
		byMessage.set(item.originMessageId, [...(byMessage.get(item.originMessageId) ?? []), item]);
	}
	return byMessage;
}

/**
 * The top of a thread started from the pod's chat: what it is called, who
 * started it and where, and the message it was started from.
 */
function ThreadIntro({ details, pod }: { details: ThreadDetails; pod: Pod }) {
	const { thread } = details;
	const starter = details.members.find((member) => member.id === thread.initiatorUserId);
	return (
		<div className="flex flex-col gap-1.5 px-5 pt-6 pb-4">
			<h2 className="m-0 font-bold text-[22px] text-foreground leading-tight">{thread.title}</h2>
			<p className="m-0 text-[13.5px] text-muted-foreground">
				{starter ? `Started by ${starter.name} in ${pod.name}` : `Started in ${pod.name}`},{" "}
				{formatListTime(new Date(thread.createdAt), new Date())}
			</p>
			{details.startedFrom && (
				<StartedFrom message={details.startedFrom} mentionable={mentionableIn(details)} />
			)}
		</div>
	);
}

/** In a thread's intro, the whole of the message in the pod's chat it was started from, and its files by name. */
function StartedFrom({
	message,
	mentionable,
}: {
	message: Message;
	mentionable: ThreadParticipant[];
}) {
	const files = message.parts.filter((part): part is FilePart => part.type === "file");
	return (
		<div className="mt-1 flex max-w-[720px] flex-col gap-1 border-border-strong border-l-2 pl-3">
			<span className="font-semibold text-[14px] text-foreground">
				{messageAuthorName(message.author)}
			</span>
			{message.content !== "" && (
				<p className="m-0 whitespace-pre-wrap break-words text-[15px] text-soft-foreground leading-[1.5]">
					{textWithMentions(message.content, mentionable)}
				</p>
			)}
			{files.length > 0 && (
				<p className="m-0 truncate text-[13px] text-muted-foreground">
					{files.map((file) => file.name).join(", ")}
				</p>
			)}
		</div>
	);
}

/** The top of a routine's own thread: what the routine is called, and the bot that runs it. */
function RoutineIntro({ title, agent }: { title: string; agent: Agent }) {
	return (
		<div className="flex flex-col gap-1.5 px-5 pt-6 pb-4">
			<h2 className="m-0 font-bold text-[22px] text-foreground leading-tight">{title}</h2>
			<p className="m-0 text-[13.5px] text-muted-foreground">
				Runs as {agent.name}. Each run posts here.
			</p>
		</div>
	);
}

/** The top of a pod's chat: how many are in it, and what the chat is for. */
function PodChatIntro({ pod, name, details }: { pod: Pod; name: string; details: ThreadDetails }) {
	const people = details.members.length;
	const bots = details.crew.filter((member) => member.kind === "agent").length;
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<PodChatTile color={pod.color} size={64} />
			<h2 className="m-0 pt-1 font-bold text-[24px] text-foreground tracking-[-0.01em]">{name}</h2>
			<p className="m-0 max-w-[560px] text-[14.5px] text-muted-foreground leading-[1.5]">
				This is the start of {name}, with {countOf(people, "person", "people")} and{" "}
				{countOf(bots, "bot", "bots")}. Talk here, or mention a bot to start a thread with it.
			</p>
		</div>
	);
}

/**
 * The top of a chat, once there is nothing older to load: whom it is with;
 * in a thread, what they do; in a Personal pod, that it is the person's own;
 * or, in a bot's channel, that it is the channel's start.
 */
/**
 * Where a bot's chat is: the person's own with it, its channel, or a thread
 * with it, which starts under the thread's name once that is known.
 */
type IntroPlace = { kind: "personal" } | { kind: "channel" } | { kind: "thread"; title?: string };

function ChatIntro({ agent, place }: { agent: Agent; place: IntroPlace }) {
	// A thread is about something, so its name leads and the bot is beside it, smaller.
	if (place.kind === "thread" && place.title) {
		return (
			<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
				<h2 className="m-0 font-bold text-[24px] text-foreground leading-tight tracking-[-0.01em] [text-wrap:balance] max-md:text-[20px]">
					{place.title}
				</h2>
				<p className="m-0 flex max-w-[560px] items-center gap-2 text-[14.5px] text-muted-foreground leading-[1.5]">
					<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={20} />
					With {agent.name}
				</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={64} />
			<h2 className="m-0 pt-1 font-bold text-[24px] text-foreground tracking-[-0.01em]">
				{agent.name}
			</h2>
			<p className="m-0 max-w-[560px] text-[14.5px] text-muted-foreground leading-[1.5]">
				{place.kind === "personal" ? (
					"Your own bot. It works for you only and nobody else in the workspace can see this conversation."
				) : place.kind === "channel" ? (
					`This is the start of ${agent.name}'s channel.`
				) : (
					<>
						This is the start of your conversation with {agent.name}.
						{agent.description && ` ${agent.description}`}
					</>
				)}
			</p>
		</div>
	);
}

/**
 * Stands in for the composer while the agent has no model. The API refuses the
 * message anyway, so offering a box to type into would only lose the draft.
 * Only somebody who may edit the agent is offered the way to fix it.
 */
function AgentNotSetUp({ agent, pod }: { agent: Agent; pod: Pod }) {
	const backToChat = useBackToHere("Chat");
	return (
		<p className="mx-auto m-0 w-full max-w-[760px] rounded-2xl border border-border-strong px-4 py-3.5 text-base text-muted-foreground leading-relaxed">
			{agent.name} has no model yet, so it cannot answer.{" "}
			{pod.permissions.updateAgents ? (
				<>
					<Link
						{...agentSettingsLink({ pod, agent })}
						state={backToChat}
						className={buttonStyles({ variant: "link", size: "bare" })}
					>
						Choose a model
					</Link>{" "}
					to start chatting.
				</>
			) : (
				"Somebody who can edit this agent chooses its model."
			)}
		</p>
	);
}

/** Whether `item` is where a run starts in a routine's thread: its result, or the run itself when it posted none. */
function startsRun(item: ChatMessageItem): boolean {
	return item.kind === "routine" || (item.kind === "message" && !!item.message.routineResultOf);
}

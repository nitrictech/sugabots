import {
	type Agent,
	type AgentParticipant,
	type ChatHistoryEntry,
	type ChatMessageItem,
	type FilePart,
	MAX_ATTACHMENT_MEGABYTES,
	MAX_ATTACHMENTS_PER_MESSAGE,
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
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleAlert, Pause } from "lucide-react";
import {
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
	useRoutineControls,
	useSendChatMessage,
	useSetDone,
	useThreadFrom,
	useThreadStarter,
} from "@/lib/chats.ts";
import { isFileGoneRefusal, useComposerAttachments } from "@/lib/composer-attachments.ts";
import { keepFootInView, useFollowContentGrowth } from "@/lib/follow-latest.ts";
import { agentSettingsLink, conversationLink, podSettingsLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
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
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ArtifactStage } from "./Artifacts.tsx";
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatHeader, type ChatPlace, type HeaderPlace, PeopleChatHeader } from "./ChatHeader.tsx";
import { ChatMenu } from "./ChatMenu.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import { DesktopStage } from "./DesktopViewer.tsx";
import { DetailsSidebar, PeopleDetails, type ThreadContents } from "./DetailsSidebar.tsx";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { firstBotNamed, mentionableIn, textWithMentions } from "./mentions.tsx";
import { queuedBehindReply } from "./queued-messages.ts";
import { RoutineDetails } from "./RoutineDetails.tsx";
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

/**
 * What is open large beside a chat: an artifact, at its current version when
 * `version` is absent, or the bot's sandbox desktop.
 */
export type Staged =
	| { kind: "artifact"; artifactId: string; version?: number }
	| { kind: "desktop" };

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
	onStagedChange: (staged: Staged | undefined) => void;
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
	// Where the log was last scrolled to. `followingLatest` is the intent to stay
	// at the latest message, which can be set before the scroll that gets there.
	const [latestInView, setLatestInView] = useState(true);
	const details = mainThread.data;
	const agent = conversation.kind === "botThread" ? conversation.agent : null;
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
	const groups = chatGroupsOf(items);
	const startedThreads = threadsByMessage(items);
	const latestItemRevision = chatItemRevision(items.at(-1));
	const newest = items.at(-1);
	useMarkReadWhileSeen(conversationId, newest, latestInView);
	const shownMessages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
	const threadActivityAt = new Map(
		entries.map((entry) => [entry.threadId, entry.latestActivityAt]),
	);
	const queued = queuedBehindReply(shownMessages, details?.queuedSince ?? null);
	const threadWith = isPodChat && details ? firstBotNamed(draft, details.crew) : undefined;
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

	/** Opens a thread started from the pod's chat in its own place. */
	function openPodThread(threadId: string) {
		void navigate(conversationLink({ pod, conversationId: threadId }));
	}

	/** Starts a thread between people from `message`, or opens the one it has. */
	async function threadFromMessage(message: Message) {
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
		opener.current = document.activeElement as HTMLElement;
		onThreadChange(nextThreadId);
	}

	const title = details?.thread.title;
	const listedChat = useChatList(pod.slug).data?.chats.find(
		(chat) => chat.conversation.id === conversationId,
	)?.conversation;
	// An archived chat is not listed, so it goes by the name it was archived with.
	const podChatName = listedChat?.title ?? title ?? "";
	// A conversation in a Personal pod is the person's own with their bot: it goes by
	// the bot's name, and is kept going rather than marked done.
	const direct = pod.kind === "personal" && details?.thread.type === "conversation";
	// Only a conversation is ever done: not the pod's chat, nor a routine's thread.
	const done =
		details?.thread.type === "conversation" && !direct
			? { isDone: details.thread.doneAt !== null, onChange: (to: boolean) => setDone.mutate(to) }
			: undefined;
	const headerPlace: HeaderPlace =
		place.kind === "away"
			? { back: place.back, trailing: place.trailing }
			: {
					back: { to: "pod", pod },
					details: staged
						? undefined
						: { open: place.detailsOpen, onChange: place.onDetailsChange },
				};
	const header =
		conversation.kind === "botThread" ? (
			<ChatHeader
				{...headerPlace}
				agent={conversation.agent}
				title={direct ? undefined : title}
				onlyYou={direct}
				done={done}
				routine={details?.routine}
				conversationId={conversationId}
				onOpenDesktop={openDesktop}
			/>
		) : conversation.kind === "podChat" ? (
			<PeopleChatHeader
				back={headerPlace.back}
				trailing={headerPlace.trailing}
				title={podChatName}
				tile={<PodChatTile color={pod.color} size={28} />}
				description="Everyone in the pod. Mention a bot to start a thread with it."
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
			<PeopleChatHeader {...headerPlace} title={title ?? ""} done={done} />
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
				className={cn(
					"relative flex min-w-0 flex-1 flex-col",
					staged && "md:w-[440px] md:flex-none md:border-border md:border-r",
				)}
			>
				{header}
				<FileDropTarget
					heading="Drop files to attach"
					detail={`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files, ${MAX_ATTACHMENT_MEGABYTES} MB each`}
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
							followingLatest.current = atFoot;
							setLatestInView(atFoot);
						}}
						className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-4"
					>
						{/* Anchored to the bottom, so a short chat sits just above the composer. */}
						<div className="flex min-h-full w-full flex-col justify-end">
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
									agent && <ChatIntro agent={agent} direct={direct} />
								))}
							{groups.map((group) => (
								<Fragment key={group.key}>
									{group.separated && <DaySeparator at={group.at} />}
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
											onStartThread={isPodChat ? threadFromMessage : undefined}
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
									) : group.item.kind === "routine" &&
										group.item.state === "failed" &&
										details.routine ? (
										<FailedRunCard
											item={group.item}
											pod={pod}
											routine={details.routine}
											conversationId={conversationId}
											latest={details.routine.failed && group.item.id === latestRunId(items)}
											onOpenThread={openThread}
										/>
									) : (
										<ActivityLine item={group.item} entries={entries} onOpenThread={openThread} />
									)}
								</Fragment>
							))}
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
					<div className="shrink-0 px-4 md:px-5">
						{agent?.model === null ? (
							<AgentNotSetUp agent={agent} pod={pod} />
						) : (
							<ChatComposer
								label={composerLabel}
								value={draft}
								onValueChange={setDraft}
								onSubmit={submit}
								submitLabel="Send message"
								sending={send.isPending || threads.isPending}
								error={startError ?? (send.isError ? sendFailureMessage(send.error) : undefined)}
								className="w-full"
								mentionable={composerMentionable}
								replyingTo={
									replyingTo && { message: replyingTo, onCancel: () => setReplyingTo(undefined) }
								}
								attachments={attachments}
							/>
						)}
						{/* Always its height, so nothing moves as somebody starts or stops typing. */}
						<div className="flex h-[26px] items-center">
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
					onClose={() => onStagedChange(undefined)}
				/>
			) : staged?.kind === "desktop" && agent ? (
				<DesktopStage
					threadId={details.thread.id}
					agent={agent}
					mayUse={pod.permissions.useDesktops}
					onClose={() => onStagedChange(undefined)}
				/>
			) : threadId && agent ? (
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
				!isPodChat &&
				(details.routine && agent ? (
					<RoutineDetails
						agent={agent}
						pod={pod}
						conversationId={conversationId}
						standing={details.routine}
						onOpenThread={openThread}
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
function chatGroupsOf(items: readonly ChatMessageItem[]): ChatGroup[] {
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
		const separated = startsNewDay(previousAt, at);
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
			row.scrollIntoView({ block: "center" });
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
 * A routine run that failed: when, and why. The latest, while the routine is
 * still failing, offers to try again or to see to the connection it needs.
 */
function FailedRunCard({
	item,
	pod,
	routine,
	conversationId,
	latest,
	onOpenThread,
}: {
	item: Extract<ChatMessageItem, { kind: "routine" }>;
	pod: Pod;
	routine: NonNullable<ThreadDetails["routine"]>;
	conversationId: string;
	latest: boolean;
	onOpenThread: (threadId: string) => void;
}) {
	const controls = useRoutineControls(conversationId, routine);
	return (
		<div className="px-5 py-1.5 pl-[70px]">
			<article
				aria-label={`Run failed: ${item.routineName}`}
				className="flex max-w-[520px] gap-3 rounded-[10px] border border-failed-card-border bg-failed-card px-3.5 py-3"
			>
				<CircleAlert
					aria-hidden
					size={17}
					strokeWidth={2}
					className="mt-px shrink-0 text-destructive-text"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<button
						type="button"
						onClick={() => onOpenThread(item.threadId)}
						className="focus-ring self-start rounded-sm text-left font-semibold text-[14px] text-failed-card-heading"
					>
						Run failed {formatListTime(new Date(item.createdAt), new Date())}
					</button>
					{item.error && <p className="m-0 text-[13.5px] text-failed-card-text">{item.error}</p>}
					{latest && (
						<div className="mt-1.5 flex gap-2">
							<Button
								size="sm"
								disabled={controls.pending}
								onClick={() => void controls.runAgain()}
							>
								Retry
							</Button>
							<Button size="sm" variant="secondary" render={<Link {...podSettingsLink(pod)} />}>
								Fix connection
							</Button>
						</div>
					)}
				</div>
			</article>
		</div>
	);
}

/**
 * A thread started from a message in the pod's chat, as a line under that
 * message, drawn as a collaboration is: the faces of who started it and its
 * bot, its name, when it last moved, and how many replies it has, or dots
 * while its bot has yet to answer.
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
	const faces = [
		...(startedBy && startedBy.kind !== "routine_trigger" ? [startedBy] : []),
		...(item.agent ? [item.agent] : []),
	];
	return (
		<SideThreadLine
			faces={faces}
			label={item.title}
			description={`Open thread: ${item.title}`}
			lastActivityAt={item.lastReplyAt ?? undefined}
			tag={
				item.replies > 0
					? { text: countOf(item.replies, "reply", "replies") }
					: item.agent
						? "working"
						: undefined
			}
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
 * The top of a chat, once there is nothing older to load: whom it is with,
 * and what they do, or, `direct` in a Personal pod, that it is the person's own.
 */
function ChatIntro({ agent, direct }: { agent: Agent; direct: boolean }) {
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={64} />
			<h2 className="m-0 pt-1 font-bold text-[24px] text-foreground tracking-[-0.01em]">
				{agent.name}
			</h2>
			<p className="m-0 max-w-[560px] text-[14.5px] text-muted-foreground leading-[1.5]">
				{direct ? (
					"Your own bot. It works for you only and nobody else in the workspace can see this conversation."
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
					<Button
						size="bare"
						variant="link"
						render={<Link {...agentSettingsLink({ pod, agent })} state={backToChat} />}
					>
						Choose a model
					</Button>{" "}
					to start chatting.
				</>
			) : (
				"Somebody who can edit this agent chooses its model."
			)}
		</p>
	);
}

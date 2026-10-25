import {
	type Agent,
	type ChatHistoryEntry,
	type ChatMessageItem,
	type Message,
	type Pod,
	quotedPreview,
	type SessionUser,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	Fragment,
	type RefObject,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { v4 as uuidv4 } from "uuid";
import { useAuthorLinks } from "@/lib/author-links.ts";
import { useChatDraft, useChatReplyDraft } from "@/lib/chat-draft.ts";
import { chatFileUrl } from "@/lib/chat-files.ts";
import {
	useChat,
	useChatHistory,
	useChatMessages,
	useMarkReadWhileSeen,
	useOptimisticChatItems,
	useSendChatMessage,
} from "@/lib/chats.ts";
import { isFileGoneRefusal, useComposerAttachments } from "@/lib/composer-attachments.ts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { keepFootInView, useFollowContentGrowth } from "@/lib/follow-latest.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { listNames } from "@/lib/name-list.ts";
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
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ArtifactStage } from "./Artifacts.tsx";
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatHeader, type ChatPlace } from "./ChatHeader.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import { DesktopStage } from "./DesktopViewer.tsx";
import { DetailsSidebar } from "./DetailsSidebar.tsx";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { type AppIdentity, appCallsIn, appIdentityOf, McpAppStage } from "./McpAppFrame.tsx";
import { mentionableIn } from "./mentions.tsx";
import { queuedBehindReply } from "./queued-messages.ts";
import {
	DaySeparator,
	startsNewDay,
	ThreadConversation,
	typersAfter,
} from "./ThreadConversation.tsx";
import { ThreadNotices } from "./ThreadNotices.tsx";
import { anyoneTyping, TypingIndicator } from "./TypingIndicator.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/**
 * How close to the foot of the log still counts as at the latest message, both
 * for following new messages and for marking the chat read: about two lines, so
 * a small nudge up is not taken as scrolling away.
 */
const LATEST_IN_VIEW_TOLERANCE_PX = 48;

/**
 * What is open large beside a chat: an artifact, at its current version when
 * `version` is absent, the bot's sandbox desktop, or the MCP App a tool call
 * was shown in.
 */
export type Staged =
	| { kind: "artifact"; artifactId: string; version?: number }
	| { kind: "desktop" }
	| { kind: "app"; toolCallId: string };

export function AgentChat({
	agent,
	pod,
	user,
	threadId,
	focusMessageId,
	place,
	onThreadChange,
	staged,
	onStagedChange,
}: {
	agent: Agent;
	pod: Pod;
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
	const openApp = (toolCallId: string) => onStagedChange({ kind: "app", toolCallId });
	const looks = useConnectionLooks(pod.id);
	const chat = useChat(pod, agent.id);
	const messages = useChatMessages(chat.data?.id);
	const history = useChatHistory(chat.data?.id);
	const mainThread = useThread(chat.data?.mainThreadId);
	const authorLinkOf = useAuthorLinks(pod.id);
	useThreadEvents(chat.data?.mainThreadId);
	const notices = useThreadNotices(chat.data?.mainThreadId);
	const optimistic = useOptimisticChatItems(chat.data?.id);
	const send = useSendChatMessage(chat.data, user);
	const reactions = useReactions(user);
	const reacting = { userId: user.id, onToggle: reactions.toggle, onAdd: reactions.add };
	const [draft, setDraft] = useChatDraft(user.id, pod.id, agent.id);
	const [replyingTo, setReplyingTo] = useChatReplyDraft(user.id, pod.id, agent.id);
	const attachments = useComposerAttachments(chat.data?.id);
	const [peopleOnly, setPeopleOnly] = useState(false);
	useTypingSignal(chat.data?.mainThreadId, draft);
	const peopleTyping = usePeopleTyping(chat.data?.mainThreadId, user.id);
	const viewport = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const previousThreadId = useRef<string | undefined>(undefined);
	const positionedAtLatest = useRef(false);
	const followingLatest = useRef(true);
	// Where the log was last scrolled to. `followingLatest` is the intent to stay
	// at the latest message, which can be set before the scroll that gets there.
	const [latestInView, setLatestInView] = useState(true);
	const details = mainThread.data;
	const host = details?.participants.find(
		(participant): participant is AgentParticipant =>
			participant.kind === "agent" && participant.id === agent.id,
	);
	const entries = history.entries;
	const selectedEntry = threadId ? entries.find((entry) => entry.threadId === threadId) : undefined;
	const items = mergeChatItems(messages.items, optimistic, details?.messages ?? []);
	const sending = sendingIds(optimistic, messages.items, details?.messages ?? []);
	const groups = chatGroupsOf(items);
	const latestItemRevision = chatItemRevision(items.at(-1));
	const newest = items.at(-1);
	useMarkReadWhileSeen(chat.data?.id, newest, latestInView);
	const shownMessages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
	const threadActivityAt = new Map(
		entries.map((entry) => [entry.threadId, entry.latestActivityAt]),
	);
	const queued = queuedBehindReply(shownMessages, details?.queuedSince ?? null);
	const appCalls = shownMessages.flatMap((message) => appCallsIn(message.parts));
	const stagedAppCall =
		staged?.kind === "app" ? appCalls.find((call) => call.id === staged.toolCallId) : undefined;

	useLayoutEffect(() => {
		if (!chat.data || !details) return;
		if (threadId && !previousThreadId.current) {
			opener.current = document.activeElement as HTMLElement;
		}
		if (!threadId && previousThreadId.current) requestAnimationFrame(() => opener.current?.focus());
		previousThreadId.current = threadId;
	}, [chat.data, details, threadId]);

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
		if (send.isPending) return;
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
				peopleOnly: writingToPeople,
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

	/** Asks the bot, in the chat, to put into words what an app that didn't open would have shown. */
	function askToDescribe(app: AppIdentity) {
		followingLatest.current = true;
		void send
			.mutateAsync({
				id: uuidv4(),
				message: `${app.name} didn't open for me. Can you describe what you showed there in words?`,
				peopleOnly: false,
			})
			.then(scrollToLatest, () => undefined);
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

	const header = (
		<ChatHeader
			agent={agent}
			pod={pod}
			place={place}
			staged={staged !== undefined}
			onOpenDesktop={openDesktop}
		/>
	);
	if (chat.isPending) return <div className="flex min-w-0 flex-1 flex-col">{header}</div>;
	if (!chat.data || chat.isError)
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				<EmptyState title="Could not open this chat">
					The API did not answer. Reload this page to try again.
				</EmptyState>
			</div>
		);
	if (!details || !host)
		return (
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				{!mainThread.isPending && (
					<EmptyState title="Could not load this chat">
						The chat is missing its main conversation.
					</EmptyState>
				)}
			</div>
		);

	const mentionable = mentionableIn(details);
	// The people here and this chat's own bot, not yourself; the pod's other bots are not offered.
	const composerMentionable = mentionable.filter(
		(candidate) =>
			candidate.id !== user.id && (candidate.kind === "person" || candidate.id === host.id),
	);
	// The pod's people, not only those who have written here, so a new bot's chat can start people-only.
	const otherPeople = mentionable.filter(
		(candidate) => candidate.kind === "person" && candidate.id !== user.id,
	);
	const writingToPeople = peopleOnly && otherPeople.length > 0;
	// Written to the people here rather than the bot: their names, with the rest counted.
	const composerLabel = writingToPeople
		? `Message ${listNames(otherPeople.map((person) => person.name))}`
		: `Message ${agent.name}`;
	const typers = typersAfter(shownMessages, peopleTyping);

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
					onDropFiles={agent.model === null ? undefined : attachments.attach}
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
							{messages.isSuccess && !messages.hasNextPage && <ChatIntro agent={agent} />}
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
											fileUrlOf={(fileId) => chatFileUrl(chat.data.id, fileId)}
											previews={!staged}
											apps={{
												// One app runs in the chat, the latest, unless something is open beside it.
												liveCallId: staged ? undefined : appCalls.at(-1)?.id,
												stagedCallId: staged?.kind === "app" ? staged.toolCallId : undefined,
												onOpen: openApp,
												onAskToDescribe: askToDescribe,
											}}
											podId={pod.id}
											approvalCapabilities={details.capabilities}
											queued={queued}
											sending={sending}
											showsTyping={false}
											highlightedMessageId={jump.pointedOut}
											threadActivityAt={threadActivityAt}
											authorLinkOf={authorLinkOf}
											onReply={replyTo}
											onJumpToMessage={jumpTo}
											reacting={reacting}
										/>
									) : (
										<ActivityLine
											item={group.item}
											host={host}
											entry={entries.find((entry) => entry.threadId === group.item.threadId)}
											onOpen={() => openThread(group.item.threadId)}
										/>
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
						{agent.model === null ? (
							<AgentNotSetUp agent={agent} pod={pod} />
						) : (
							<ChatComposer
								label={composerLabel}
								value={draft}
								onValueChange={setDraft}
								onSubmit={submit}
								submitLabel="Send message"
								sending={send.isPending}
								error={send.isError ? sendFailureMessage(send.error) : undefined}
								className="w-full"
								mentionable={composerMentionable}
								peopleOnly={
									otherPeople.length > 0
										? { on: writingToPeople, onChange: setPeopleOnly, agent: host }
										: undefined
								}
								replyingTo={
									replyingTo && { message: replyingTo, onCancel: () => setReplyingTo(undefined) }
								}
								attachments={attachments}
							/>
						)}
						{/* Always its height, so nothing moves as somebody starts or stops typing. */}
						<div className="flex h-[26px] items-center">
							{anyoneTyping(typers) && <TypingIndicator typers={typers} className="px-1" />}
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
			) : staged?.kind === "app" ? (
				<McpAppStage
					call={stagedAppCall}
					app={stagedAppCall && appIdentityOf(stagedAppCall, looks, agent.name)}
					onClose={() => onStagedChange(undefined)}
					onAskToDescribe={askToDescribe}
				/>
			) : staged?.kind === "desktop" ? (
				<DesktopStage
					threadId={details.thread.id}
					agent={agent}
					mayUse={pod.permissions.useDesktops}
					onClose={() => onStagedChange(undefined)}
				/>
			) : threadId ? (
				<ChatThreadPanel
					chatId={chat.data.id}
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
				place.detailsOpen && (
					<DetailsSidebar
						agent={agent}
						pod={pod}
						threadId={details.thread.id}
						user={user}
						onClose={() => place.onDetailsChange(false)}
					/>
				)
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

type ChatActivityItem = Extract<ChatMessageItem, { kind: "collaboration" | "routine" }>;

/** A routine run, or another bot's collaboration with this one, as a row among the messages. */
function ActivityLine({
	item,
	host,
	entry,
	onOpen,
}: {
	item: ChatActivityItem;
	host: AgentParticipant;
	entry: ChatHistoryEntry | undefined;
	onOpen: () => void;
}) {
	const state = activityStateOf(entry);
	return item.kind === "routine" ? (
		<ChatActivityRow
			type="routine"
			routineName={item.routineName}
			triggerKind={item.triggerKind}
			state={state}
			at={item.createdAt}
			onOpen={onOpen}
		/>
	) : (
		<ChatActivityRow
			type="collaboration"
			initiator={item.initiator}
			recipient={host}
			inChatOf="recipient"
			state={state}
			at={item.createdAt}
			onOpen={onOpen}
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
	for (const item of items) {
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
	return item.kind === "message" ? `message:${item.message.id}` : `collaboration:${item.id}`;
}

function chatItemCreatedAt(item: ChatMessageItem): string {
	return item.kind === "message" ? item.message.createdAt : item.createdAt;
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

/** The top of a chat, once there is nothing older to load: whom it is with, and what they do. */
function ChatIntro({ agent }: { agent: Agent }) {
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={64} />
			<h2 className="m-0 pt-1 font-bold text-[24px] text-foreground tracking-[-0.01em]">
				{agent.name}
			</h2>
			<p className="m-0 max-w-[560px] text-[14.5px] text-muted-foreground leading-[1.5]">
				This is the start of your conversation with {agent.name}.
				{agent.description && ` ${agent.description}`}
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

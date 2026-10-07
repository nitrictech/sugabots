import type {
	Agent,
	ChatHistoryEntry,
	ChatMessageItem,
	Pod,
	SessionUser,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
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
import { useChatDraft } from "@/lib/chat-draft.ts";
import {
	useChat,
	useChatHistory,
	useChatMessages,
	useOptimisticChatItems,
	useReadWhileShown,
	useSendChatMessage,
} from "@/lib/chats.ts";
import { keepFootInView, useFollowContentGrowth } from "@/lib/follow-latest.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { listNames } from "@/lib/name-list.ts";
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
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatHeader, type ChatPlace } from "./ChatHeader.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import { DetailsSidebar } from "./DetailsSidebar.tsx";
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

export function AgentChat({
	agent,
	pod,
	user,
	threadId,
	focusMessageId,
	place,
	onThreadChange,
}: {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	threadId?: string;
	/** A message to jump to and point out, such as the mention it was opened from. */
	focusMessageId?: string;
	place: ChatPlace;
	onThreadChange: (threadId: string | undefined) => void;
}) {
	const chat = useChat(pod, agent.id);
	const messages = useChatMessages(chat.data?.id);
	const history = useChatHistory(chat.data?.id);
	const mainThread = useThread(chat.data?.mainThreadId);
	const authorLinkOf = useAuthorLinks(pod.id);
	useThreadEvents(chat.data?.mainThreadId);
	const notices = useThreadNotices(chat.data?.mainThreadId);
	const optimistic = useOptimisticChatItems(chat.data?.id);
	const send = useSendChatMessage(chat.data, user);
	const [draft, setDraft] = useChatDraft(user.id, pod.id, agent.id);
	const [peopleOnly, setPeopleOnly] = useState(false);
	useTypingSignal(chat.data?.mainThreadId, draft);
	const peopleTyping = usePeopleTyping(chat.data?.mainThreadId, user.id);
	const viewport = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const previousThreadId = useRef<string | undefined>(undefined);
	const positionedAtLatest = useRef(false);
	const followingLatest = useRef(true);
	const details = mainThread.data;
	const host = details?.participants.find(
		(participant): participant is AgentParticipant =>
			participant.kind === "agent" && participant.id === agent.id,
	);
	const entries = history.entries;
	const selectedEntry = threadId ? entries.find((entry) => entry.threadId === threadId) : undefined;
	const items = mergeChatItems(messages.items, optimistic, details?.messages ?? []);
	const groups = chatGroupsOf(items);
	const latestItemRevision = chatItemRevision(items.at(-1));
	const newest = items.at(-1);
	useReadWhileShown(
		chat.data?.id,
		newest?.kind === "message" ? `${newest.message.id}:${newest.message.status}` : newest?.id,
	);
	const shownMessages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
	const threadActivityAt = new Map(
		entries.map((entry) => [entry.threadId, entry.latestActivityAt]),
	);
	const queued = queuedBehindReply(shownMessages, details?.queuedSince ?? null);

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

	const jump = useJumpToMessage({
		messageId: focusMessageId,
		shown: shownMessages.some((message) => message.id === focusMessageId),
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
		const message = draft.trim();
		if (!message || send.isPending) return;
		const submitted = draft;
		setDraft("");
		followingLatest.current = true;
		try {
			const sent = send.mutateAsync({
				id: uuidv4(),
				message,
				peopleOnly: writingToPeople,
			});
			scrollToLatest();
			await sent;
			scrollToLatest();
		} catch {
			setDraft((current) => (current === "" ? submitted : current));
		}
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

	const header = <ChatHeader agent={agent} pod={pod} place={place} />;
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
	const otherPeople = details.participants.filter(
		(participant) => participant.kind === "person" && participant.id !== user.id,
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
			<div className="relative flex min-w-0 flex-1 flex-col">
				{header}
				<div
					ref={attachViewport}
					role="log"
					aria-label="Chat messages"
					onScroll={(event) => {
						const element = event.currentTarget;
						followingLatest.current =
							element.scrollHeight - element.scrollTop - element.clientHeight < 48;
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
										podId={pod.id}
										canApproveToolCalls={details.capabilities?.approveToolCalls}
										queued={queued}
										showsTyping={false}
										highlightedMessageId={jump.pointedOut}
										threadActivityAt={threadActivityAt}
										authorLinkOf={authorLinkOf}
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
							<p role="status" className="m-0 px-5 py-2 text-center text-muted-foreground text-sm">
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
							submitDisabled={!draft.trim() || send.isPending}
							error={send.isError ? "Message not sent. Your draft is still here." : undefined}
							className="w-full"
							mentionable={composerMentionable}
							peopleOnly={
								otherPeople.length > 0
									? { on: writingToPeople, onChange: setPeopleOnly, agent: host }
									: undefined
							}
						/>
					)}
					{/* Always its height, so nothing moves as somebody starts or stops typing. */}
					<div className="flex h-[26px] items-center">
						{anyoneTyping(typers) && <TypingIndicator typers={typers} className="px-1" />}
					</div>
				</div>
			</div>
			{/* One sidebar at a time: an opened collaboration or run takes Details' place. */}
			{threadId ? (
				<ChatThreadPanel
					chatId={chat.data.id}
					chatAgentId={agent.id}
					threadId={threadId}
					entry={selectedEntry}
					history={entries}
					frame={{ kind: "sidebar", onClose: () => onThreadChange(undefined) }}
					onOpenThread={openThread}
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

/**
 * Jumps to `messageId` once it is shown, loading older pages until it is, up
 * to a limit, then centres it, moves the focus to it, and points it out for a
 * moment. Each message is jumped to once. Returns the message pointed out, if
 * any, and whether the search gave up without finding it.
 */
function useJumpToMessage({
	messageId,
	shown,
	viewport,
	older,
	loadOlder,
	pagesLoaded,
	onJumped,
}: {
	messageId: string | undefined;
	/** Whether the message is among those loaded. */
	shown: boolean;
	viewport: RefObject<HTMLDivElement | null>;
	/** Whether an older page can be loaded now, is on its way, or there is none. */
	older: "available" | "loading" | "none";
	loadOlder: () => Promise<void>;
	pagesLoaded: number;
	onJumped: () => void;
}): { pointedOut: string | undefined; notFound: boolean } {
	const jumped = useRef<string>(undefined);
	const [pointedOut, setPointedOut] = useState<string>();
	const loadOlderPage = useEffectEvent(() => void loadOlder());
	const jumpedTo = useEffectEvent(onJumped);
	const searchedEnough = pagesLoaded >= MAX_PAGES_TO_FIND;
	useEffect(() => {
		if (!messageId || jumped.current === messageId) return;
		if (!shown) {
			if (older === "available" && !searchedEnough) loadOlderPage();
			return;
		}
		const row = [
			...(viewport.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
		].find((candidate) => candidate.dataset.messageId === messageId);
		if (!row) return;
		jumped.current = messageId;
		// In the next frame, after the scroll event from the chat's first move to its
		// foot, which would otherwise say the chat is following its latest again.
		requestAnimationFrame(() => {
			row.scrollIntoView({ block: "center" });
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
			jumpedTo();
		});
		setPointedOut(messageId);
	}, [messageId, shown, viewport, older, searchedEnough]);
	useEffect(() => {
		if (!pointedOut) return;
		const fade = setTimeout(() => setPointedOut(undefined), POINTED_OUT_MS);
		return () => clearTimeout(fade);
	}, [pointedOut]);
	const notFound =
		messageId !== undefined &&
		!shown &&
		older !== "loading" &&
		(older === "none" || searchedEnough);
	return { pointedOut, notFound };
}

/** The top of a chat, once there is nothing older to load: whom it is with, and what they do. */
function ChatIntro({ agent }: { agent: Agent }) {
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<AgentAvatar color={agent.color} face={agent.face} size={64} />
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

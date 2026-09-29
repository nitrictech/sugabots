import type {
	Agent,
	ChatHistoryEntry,
	ChatMessageItem,
	Pod,
	SessionUser,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import {
	useChat,
	useChatHistory,
	useChatMessages,
	useOptimisticChatItems,
	useSendChatMessage,
} from "@/lib/chats.ts";
import { useFollowContentGrowth } from "@/lib/follow-latest.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useThreadEvents, useThreadNotices } from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { activityStateOf, ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import { DetailsSidebar } from "./DetailsSidebar.tsx";
import { queuedBehindReply } from "./queued-messages.ts";
import { DaySeparator, separatesFrom, ThreadConversation } from "./ThreadConversation.tsx";
import { ThreadNotices } from "./ThreadNotices.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

export function AgentChat({
	agent,
	pod,
	user,
	threadId,
	detailsOpen,
	onDetailsClose,
	onThreadChange,
}: {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	threadId?: string;
	/** Whether the Details sidebar is open beside the messages. */
	detailsOpen: boolean;
	onDetailsClose: () => void;
	onThreadChange: (threadId: string | undefined) => void;
}) {
	const chat = useChat(pod.id, agent.id);
	const messages = useChatMessages(chat.data?.id);
	const history = useChatHistory(chat.data?.id);
	const mainThread = useThread(chat.data?.mainThreadId);
	useThreadEvents(chat.data?.mainThreadId);
	const notices = useThreadNotices(chat.data?.mainThreadId);
	const optimistic = useOptimisticChatItems(chat.data?.id);
	const send = useSendChatMessage(chat.data, user);
	const [draft, setDraft] = useState("");
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
	const latestItemRevision = chatItemRevision(items.at(-1));
	const queued = queuedBehindReply(
		items.flatMap((item) => (item.kind === "message" ? [item.message] : [])),
	);

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

	useFollowContentGrowth(viewport, followingLatest);

	async function submit() {
		const message = draft.trim();
		if (!message || send.isPending) return;
		const submitted = draft;
		setDraft("");
		followingLatest.current = true;
		try {
			const sent = send.mutateAsync({ id: crypto.randomUUID(), message });
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

	if (chat.isPending) return null;
	if (!chat.data || chat.isError)
		return (
			<EmptyState title="Could not open this chat">
				The API did not answer. Reload this page to try again.
			</EmptyState>
		);
	if (!details || !host)
		return mainThread.isPending ? null : (
			<EmptyState title="Could not load this chat">
				The chat is missing its main conversation.
			</EmptyState>
		);

	return (
		// Not positioned on a phone, so a sidebar there covers the chat's header as well as the chat.
		<div className="flex min-h-0 flex-1 md:relative">
			<div className="relative flex min-w-0 flex-1 flex-col">
				<div
					ref={viewport}
					role="log"
					aria-label="Chat messages"
					onScroll={(event) => {
						const element = event.currentTarget;
						followingLatest.current =
							element.scrollHeight - element.scrollTop - element.clientHeight < 48;
					}}
					className="min-h-0 flex-1 overflow-y-auto pt-[22px] pb-3"
				>
					{/* The same inset as the header and the composer, so the faces, the + and the header line up. */}
					<div className="flex min-h-full w-full flex-col px-4 md:px-[22px]">
						{messages.isError && (
							<Alert>Messages could not be loaded. Reload this page to try again.</Alert>
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
						{items.length === 0 && (
							<div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
								<AgentAvatar color={agent.color} face={agent.face} size={88} />
								<h2 className="m-0 pt-1.5 font-bold text-[20px] text-foreground">
									Say hello to {agent.name}
								</h2>
								<p className="m-0 text-[14px] text-muted-foreground">
									Your chats with {agent.name} will show up here.
								</p>
							</div>
						)}
						{chatGroupsOf(items).map((group) => (
							<Fragment key={group.key}>
								{group.separated && <DaySeparator at={group.at} />}
								{group.kind === "messages" ? (
									<ThreadConversation
										messages={group.messages}
										host={host}
										isRunning={false}
										participants={[...details.participants, ...details.crew]}
										user={user}
										dividers={false}
										onOpenCollaboration={openThread}
										podId={pod.id}
										canApproveToolCalls={details.capabilities?.approveToolCalls}
										queued={queued}
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
						<ThreadNotices notices={notices} />
					</div>
				</div>
				<div className="shrink-0 px-4 pt-2.5 pb-[18px] md:px-[22px]">
					{agent.model === null ? (
						<AgentNotSetUp agent={agent} pod={pod} />
					) : (
						<ChatComposer
							label={`Message ${agent.name}`}
							placeholder={`Message ${agent.name}`}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Send message"
							submitDisabled={!draft.trim() || send.isPending}
							error={send.isError ? "Message not sent. Your draft is still here." : undefined}
							className="w-full"
						/>
					)}
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
					user={user}
					onClose={() => onThreadChange(undefined)}
					onOpenThread={openThread}
				/>
			) : (
				detailsOpen && (
					<DetailsSidebar
						agent={agent}
						pod={pod}
						threadId={details.thread.id}
						user={user}
						onClose={onDetailsClose}
					/>
				)
			)}
		</div>
	);
}

type ChatActivityItem = Extract<ChatMessageItem, { kind: "collaboration" | "routine" }>;

/** A routine run, or another bot's collaboration with this one, as a centred line. */
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
		<ChatActivityRow type="routine" routineName={item.routineName} state={state} onOpen={onOpen} />
	) : (
		<ChatActivityRow
			type="collaboration"
			initiator={item.initiator}
			recipient={host}
			inChatOf="recipient"
			state={state}
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
 * row on its own. A new day, or an hour's quiet, starts a new group behind a
 * separator.
 */
function chatGroupsOf(items: readonly ChatMessageItem[]): ChatGroup[] {
	const groups: ChatGroup[] = [];
	let previousAt: string | undefined;
	for (const item of items) {
		const at = item.kind === "message" ? item.message.createdAt : item.createdAt;
		const separated = separatesFrom(previousAt ? { createdAt: previousAt } : undefined, {
			createdAt: at,
		});
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

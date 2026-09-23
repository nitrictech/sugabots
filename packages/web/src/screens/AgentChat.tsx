import type {
	Agent,
	ChatHistoryEntry,
	ChatMessageItem,
	Pod,
	SessionUser,
	ThreadParticipant,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { History, ListFilter, MessageSquare, PanelRightClose, PanelRightOpen } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	useChat,
	useChatHistory,
	useChatMessages,
	useOptimisticChatItems,
	useSendChatMessage,
} from "@/lib/chats.ts";
import { useFollowContentGrowth } from "@/lib/follow-latest.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { useThreadEvents } from "@/lib/thread-events.ts";
import { useThread } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ScribeNotSetUp } from "./BuiltInAgentSetup.tsx";
import { ChatActivityRow } from "./ChatActivityRow.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";
import { ThreadConversation } from "./ThreadConversation.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

export function AgentChat({
	agent,
	pod,
	user,
	threadId,
	historyOpen,
	onHistoryChange,
	onThreadChange,
}: {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	threadId?: string;
	historyOpen: boolean;
	onHistoryChange: (open: boolean) => void;
	onThreadChange: (threadId: string | undefined) => void;
}) {
	const chat = useChat(pod.id, agent.id);
	const messages = useChatMessages(chat.data?.id);
	const history = useChatHistory(chat.data?.id);
	const mainThread = useThread(chat.data?.mainThreadId);
	const selectedThread = useThread(threadId);
	useThreadEvents(chat.data?.mainThreadId);
	const optimistic = useOptimisticChatItems(chat.data?.id);
	const send = useSendChatMessage(chat.data, user);
	const [draft, setDraft] = useState("");
	const [summaryOpen, setSummaryOpen] = useState(true);
	const [newInChat, setNewInChat] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const previousThreadId = useRef<string | undefined>(undefined);
	const itemCountAtOpen = useRef(0);
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

	useLayoutEffect(() => {
		if (!chat.data || !details) return;
		if (threadId && !previousThreadId.current) {
			opener.current = document.activeElement as HTMLElement;
			itemCountAtOpen.current = items.length;
		}
		if (!threadId && previousThreadId.current) requestAnimationFrame(() => opener.current?.focus());
		previousThreadId.current = threadId;
	}, [chat.data, details, threadId, items.length]);

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

	useEffect(() => {
		if (threadId && items.length > itemCountAtOpen.current) setNewInChat(true);
		if (!threadId) setNewInChat(false);
	}, [threadId, items.length]);

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

	function showNewInChat() {
		onThreadChange(undefined);
		requestAnimationFrame(() => {
			if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
		});
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
		<div className="relative flex min-h-0 flex-1">
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
					className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-7"
				>
					<div className="mx-auto flex w-full max-w-[760px] flex-col gap-[15px]">
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
							<div className="grid min-h-64 place-content-center text-center">
								<span className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-sunken text-subtle-foreground">
									<MessageSquare aria-hidden size={19} />
								</span>
								<h2 className="m-0 font-semibold text-heading text-lg">
									Start a conversation with {agent.name}
								</h2>
								<p className="m-0 pt-1 text-muted-foreground text-sm">
									Send a message to start working together.
								</p>
							</div>
						)}
						{items.map((item) => {
							if (item.kind === "collaboration" || item.kind === "routine") {
								return (
									<div key={item.id} id={`chat-item-${item.id}`}>
										<ChatActivityRow
											entry={entries.find((entry) => entry.threadId === item.threadId)}
											type={item.kind}
											title={
												item.kind === "routine"
													? item.routineName
													: `${item.initiator.name} contacted me`
											}
											onOpen={() => openThread(item.threadId)}
										/>
									</div>
								);
							}
							return (
								<div key={item.message.id} id={`chat-item-${item.message.id}`}>
									<ThreadConversation
										messages={[item.message]}
										host={host}
										isRunning={false}
										mentionable={[...details.participants, ...details.crew]}
										user={user}
										dividers={false}
										onOpenCollaboration={openThread}
										threadEntries={entries}
										podId={pod.id}
										canApproveToolCalls={details.capabilities?.approveToolCalls}
										canAlwaysAllowToolCalls={details.capabilities?.alwaysAllowToolCalls}
									/>
								</div>
							);
						})}
					</div>
				</div>
				<div className="shrink-0 bg-card px-4 pb-5 pt-3 md:px-[22px]">
					{agent.model === null ? (
						<AgentNotSetUp agent={agent} pod={pod} />
					) : (
						<ChatComposer
							label={`Message ${agent.name}`}
							placeholder={`Message ${agent.name}…`}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Send message"
							submitDisabled={!draft.trim() || send.isPending}
							error={send.isError ? "Message not sent. Your draft is still here." : undefined}
							mentionables={details.crew}
							className="mx-auto w-full max-w-[760px]"
						/>
					)}
				</div>
				{threadId && (
					<ChatThreadPanel
						chatId={chat.data.id}
						threadId={threadId}
						entry={selectedEntry}
						history={entries}
						user={user}
						onClose={() => onThreadChange(undefined)}
						onOpenThread={openThread}
					/>
				)}
				{threadId && newInChat && (
					<button
						type="button"
						onClick={showNewInChat}
						className="focus-ring absolute bottom-32 left-3 z-40 rounded-full border border-border bg-card px-3 py-2 font-semibold text-heading text-xs shadow-[0_6px_18px_rgba(40,35,30,.12)]"
					>
						New in Chat
					</button>
				)}
			</div>
			{historyOpen && (
				<ChatHistory
					chatId={chat.data.id}
					agent={agent}
					selectedThreadId={threadId}
					onClose={() => onHistoryChange(false)}
					onOpen={openThread}
				/>
			)}
			{!historyOpen && summaryOpen && (
				<ChatSummaryRail
					details={selectedThread.data ?? details}
					history={entries}
					selectedEntry={selectedEntry}
				/>
			)}
			<div className="absolute right-3 top-[-55px] z-10 hidden items-center gap-2 md:flex">
				<IconButton
					label={historyOpen ? "Close Chat history" : "Open Chat history"}
					aria-pressed={historyOpen}
					onClick={() => onHistoryChange(!historyOpen)}
					variant="pane"
					size="lg"
				>
					<History size={17} />
				</IconButton>
				<IconButton
					label={summaryOpen ? "Hide chat summary" : "Show chat summary"}
					aria-pressed={summaryOpen}
					onClick={() => setSummaryOpen(!summaryOpen)}
					variant="pane"
					size="lg"
					className="hidden xl:grid"
				>
					{summaryOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
				</IconButton>
			</div>
			<button
				type="button"
				aria-label={historyOpen ? "Close Chat history" : "Open Chat history"}
				onClick={() => onHistoryChange(!historyOpen)}
				className="focus-ring absolute right-3 top-[-53px] grid size-9 place-items-center rounded-xl bg-sunken text-muted-foreground md:hidden"
			>
				<History size={16} />
			</button>
		</div>
	);
}

function ChatSummaryRail({
	details,
	history,
	selectedEntry,
}: {
	details: NonNullable<ReturnType<typeof useThread>["data"]>;
	history: ChatHistoryEntry[];
	selectedEntry?: ChatHistoryEntry;
}) {
	const title = selectedEntry
		? `${selectedEntry.type === "routine" ? "Run" : selectedEntry.type[0]?.toUpperCase()}${selectedEntry.type === "routine" ? "" : selectedEntry.type.slice(1)} summary`
		: "Chat summary";
	const counts = { collaboration: 0, routine: 0 };
	for (const entry of history) counts[entry.type] += 1;
	return (
		<aside
			aria-label={title}
			className="hidden w-[300px] shrink-0 overflow-y-auto border-border-subtle border-l bg-background px-2.5 py-3 xl:block"
		>
			{selectedEntry ? (
				<ThreadSummary details={details} entry={selectedEntry} />
			) : (
				<>
					<h2 className="m-0 px-1.5 pb-3 font-semibold text-subtle-foreground text-xs uppercase tracking-[0.06em]">
						{title}
					</h2>
					<SummaryCard details={details} />
					<section className="mt-3 rounded-[14px] border border-border-subtle bg-card px-4 py-3.5">
						<h3 className="m-0 pb-2 font-semibold text-2xs text-subtle-foreground uppercase tracking-[0.06em]">
							Threads in this chat
						</h3>
						<Fact label="Collaborations" value={counts.collaboration} />
						<Fact label="Routine runs" value={counts.routine} />
					</section>
					<Context details={details} />
				</>
			)}
		</aside>
	);
}

function ThreadSummary({
	details,
	entry,
}: {
	details: NonNullable<ReturnType<typeof useThread>["data"]>;
	entry: ChatHistoryEntry;
}) {
	const threadLabel = entry.type === "routine" ? "run" : entry.type;
	return (
		<div className="flex flex-col gap-3">
			<SummaryCard details={details} />
			<section className="rounded-2xl border border-border-subtle bg-card px-4 py-3.5">
				<CardHeading>This {threadLabel}</CardHeading>
				<dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2.5 pt-3 text-md">
					<dt className="text-muted-foreground">Started</dt>
					<dd className="m-0 text-heading">{formatDateTime(details.thread.createdAt)}</dd>
					<dt className="text-muted-foreground">Messages</dt>
					<dd className="m-0 text-heading tabular-nums">{details.messages.length}</dd>
				</dl>
				<div className="mt-3 border-border-subtle border-t pt-3">
					<CardHeading>Participants</CardHeading>
					<ul className="m-0 flex list-none flex-col gap-2.5 p-0 pt-3">
						{details.participants.map((participant) => (
							<li key={participant.id} className="flex min-w-0 items-center gap-2 text-md">
								{participant.kind === "agent" ? (
									<AgentAvatar hue={participant.hue} face={participant.face} size={21} />
								) : (
									<PersonAvatar name={participant.name} image={participant.image} size={21} />
								)}
								<span
									className={
										participant.kind === "agent"
											? "agent-tint truncate font-semibold text-agent-name"
											: "truncate font-medium text-heading"
									}
									style={
										participant.kind === "agent"
											? { ["--agent-hue" as string]: participant.hue }
											: undefined
									}
								>
									{participant.name}
								</span>
							</li>
						))}
					</ul>
				</div>
			</section>
		</div>
	);
}

function SummaryCard({ details }: { details: NonNullable<ReturnType<typeof useThread>["data"]> }) {
	return (
		<section className="rounded-2xl border border-border-subtle bg-card px-4 py-3.5">
			<CardHeading icon={<ListFilter aria-hidden size={13} className="text-primary" />}>
				Summary
			</CardHeading>
			{/* `=== false`, not `!`: the field is optional, and an absent one means
			    the API did not say rather than that the Scribe is unset. */}
			{details.summaryEnabled === false ? (
				<ScribeNotSetUp />
			) : (
				<p className="m-0 pt-2.5 text-heading text-[13.5px] leading-relaxed">
					{details.summary?.content ?? "A summary will appear after the first agent reply."}
				</p>
			)}
		</section>
	);
}

function CardHeading({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
	return (
		<h3 className="m-0 flex items-center gap-1.5 font-semibold text-2xs text-subtle-foreground uppercase tracking-[0.06em]">
			{icon}
			{children}
		</h3>
	);
}

function formatDateTime(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

function Fact({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="flex gap-3 py-1 text-md">
			<span className="w-[88px] shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 text-heading">{value}</span>
		</div>
	);
}
function Context({ details }: { details: NonNullable<ReturnType<typeof useThread>["data"]> }) {
	const context = details.usage.latestContext;
	if (!context) return null;
	const percentage = context.capacityTokens
		? Math.min(100, Math.round((context.usedTokens / context.capacityTokens) * 100))
		: undefined;
	return (
		<section className="mt-3 rounded-[14px] border border-border-subtle bg-card px-4 py-3.5">
			<h3 className="m-0 pb-2 font-semibold text-2xs text-subtle-foreground uppercase tracking-[0.06em]">
				Context
			</h3>
			<span className="font-semibold text-heading text-2xl">
				{percentage === undefined ? "—" : `${percentage}%`}
			</span>
			{percentage !== undefined && (
				<div className="mt-2 h-[7px] overflow-hidden rounded-full bg-border">
					<span
						className="block h-full rounded-full bg-agent-fill"
						style={{ width: `${percentage}%` }}
					/>
				</div>
			)}
		</section>
	);
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
	return (
		<p className="mx-auto m-0 w-full max-w-[760px] rounded-2xl border border-control-border px-4 py-3.5 text-base text-muted-foreground leading-relaxed">
			{agent.name} has no model yet, so it cannot answer.{" "}
			{pod.permissions.updateAgents ? (
				<>
					<Button
						size="bare"
						variant="link"
						render={<Link {...agentSettingsLink({ pod, agent })} />}
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

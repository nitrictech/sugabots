import {
	type ActivityItem,
	type Agent,
	type ChatMessageItem,
	type FilePart,
	handleFromName,
	type MessageReplyTo,
	type NewMessage,
	type NewThread,
	type PersonParticipant,
	type Pod,
	type RoutineUpdate,
	type SessionUser,
	type StartedThread,
	type ThreadDetails,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import {
	infiniteQueryOptions,
	type QueryClient,
	queryOptions,
	skipToken,
	useInfiniteQuery,
	useIsMutating,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { useAgents } from "@/lib/agents.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useRoutineActions } from "@/lib/routines.ts";
import { threadQuery } from "@/lib/threads.ts";
import { useWorkspace } from "@/lib/workspace.ts";

const PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

/**
 * A channel's conversations, by the channel's slug: what a chat page's
 * address names, so a page can ask for it before it knows the channel's id.
 */
function chatListQuery(workspaceId: string | undefined, podSlug: string | undefined) {
	return queryOptions({
		queryKey: ["chat-list", workspaceId, podSlug],
		queryFn:
			workspaceId && podSlug
				? ({ signal }) =>
						Effect.runPromise(
							client.api.chats.list({
								params: { workspace: workspaceId },
								query: { pod: podSlug },
							}),
							{ signal },
						)
				: skipToken,
	});
}

/** A channel's conversations, by its slug: its main chat, then its threads in the order they were started. */
export function useChatList(podSlug: string | undefined) {
	return useQuery(chatListQuery(useWorkspace().workspace?.id, podSlug));
}

/** A bot's tasks, most recent message first, and its automations. */
function botTasksQuery(workspaceId: string | undefined, agentId: string | undefined) {
	return queryOptions({
		queryKey: ["bot-tasks", workspaceId, agentId],
		queryFn:
			workspaceId && agentId
				? ({ signal }) =>
						Effect.runPromise(client.api.chats.botTasks({ params: { agentId } }), { signal })
				: skipToken,
	});
}

/** The tasks and automations of the bot `agentId`; nothing is asked while it is undefined. */
export function useBotTasks(agentId: string | undefined) {
	return useQuery(botTasksQuery(useWorkspace().workspace?.id, agentId));
}

/**
 * How each channel and bot stands for the sidebar: its unread messages,
 * whether any conversation waits on the person, and a bot's failed automations.
 */
export function usePodChatMarkers() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["chat-pod-markers", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.podMarkers({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

const activityFeedKey = (workspaceId: string | undefined) => ["chat-activity", workspaceId];
const APPROVAL_INBOX = "chat-approvals";
const approvalInboxKey = (workspaceId: string | undefined) => [APPROVAL_INBOX, workspaceId];

/**
 * What is new for the person across the workspace's chats: messages that
 * mention them or they have not read, routine runs, and collaborations.
 */
export function useActivityFeed() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: activityFeedKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.activity({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/**
 * The approvals across the workspace: those waiting on the person, and the
 * latest answered.
 */
export function useApprovalInbox() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: approvalInboxKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.approvals({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

const directMessagesKey = (workspaceId: string | undefined) => ["direct-messages", workspaceId];

/** The person's direct messages with other people, the most recent first. */
export function useDirectMessages() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: directMessagesKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.chats.directMessages({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/**
 * Sends a message to `userIds`, in the direct message between the person and
 * them, which the API opens when they have none. Resolves once the lists that
 * show it know of it, with the direct message it went to.
 */
export function useSendDirectMessage() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: ({ userIds, message }: { userIds: readonly string[]; message: string }) => {
			if (!workspaceId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.chats.sendDirectMessage({
					params: { workspace: workspaceId },
					payload: { userIds: [...userIds], id: uuidv4(), message },
				}),
			);
		},
		onSuccess: ({ conversation }) =>
			Promise.all([
				queries.invalidateQueries({ queryKey: directMessagesKey(workspaceId) }),
				queries.invalidateQueries({ queryKey: directMessageKey(conversation.id) }),
				queries.invalidateQueries({ queryKey: ["chat-messages", conversation.id] }),
				queries.invalidateQueries({ queryKey: ["thread", conversation.id] }),
			]),
	});
}

/** What a direct message with somebody who has left the workspace goes by. */
const FORMER_MEMBER = "Former member";

/** The others in a direct message between people: those still here, by name, and how many have left. */
export interface DirectPeople {
	people: readonly PersonParticipant[];
	formerMembers: number;
}

/** How many have left, as words: "1 former member". */
function formerMembersOf(count: number): string {
	return countOf(count, "former member", "former members");
}

/** A person, as a message's author or somebody it is written to. */
export function personParticipantOf(person: {
	id: string;
	name: string;
	email: string;
	image?: string | null;
}): PersonParticipant {
	return {
		kind: "person",
		id: person.id,
		name: person.name,
		email: person.email,
		handle: handleFromName(person.name),
		image: person.image ?? null,
	};
}

/** Whether a direct message is with one other person, rather than a group; who has left counts as one. */
export function isOneToOne({ people, formerMembers }: DirectPeople): boolean {
	return people.length + formerMembers <= 1;
}

/**
 * The others in a direct message as its title says them: "Juno, Theo and
 * Sam", then any who have left, "and 1 former member". One person who has
 * left is a Former member.
 */
export function directPeopleTitle({ people, formerMembers }: DirectPeople): string {
	if (people.length === 0)
		return formerMembers <= 1 ? FORMER_MEMBER : formerMembersOf(formerMembers);
	const names = people.map((person) => person.name);
	if (formerMembers === 0) return listNames(names);
	return `${names.join(", ")} and ${formerMembersOf(formerMembers)}`;
}

/** The others in a direct message as a list's row names them, shortest first: "Juno, Theo". */
export function directPeopleRowName(direct: DirectPeople): string {
	if (direct.people.length === 0) return directPeopleTitle(direct);
	return directPeopleNames(direct).join(", ");
}

/** The others in a direct message, by name, then those who have left as how many: "1 former member". */
export function directPeopleNames({ people, formerMembers }: DirectPeople): string[] {
	return [
		...people.map((person) => person.name),
		...(formerMembers > 0 ? [formerMembersOf(formerMembers)] : []),
	];
}

const directMessageKey = (conversationId: string) => ["direct-message", conversationId];

/**
 * The direct message `conversationId`, and who is in it, once loaded:
 * `found` is `undefined` when it is not one of the person's in the workspace
 * open, as one from another of their workspaces is not shown in this one's
 * place, and `error` set only when it could not be loaded at all.
 */
export function useDirectMessage(conversationId: string): {
	found: DirectPlace | undefined;
	isPending: boolean;
	error: unknown;
} {
	const workspace = useWorkspace();
	// The list is fetched afresh as the workspace's events come and the window
	// regains focus, so once it has the conversation, who is in it comes from
	// there. Until the list is loaded the conversation is asked for alongside
	// it, so the page does not wait on both in turn; once loaded, only one it
	// does not have is.
	const listed = useDirectMessages().data?.items.find(
		(candidate) => candidate.conversation.id === conversationId,
	);
	const item = useQuery({
		queryKey: directMessageKey(conversationId),
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.chats.directMessage({ params: { conversationId } }), {
				signal,
			}),
		enabled: !listed,
	});
	const missing = isApiFailure(item.error) && item.error._tag === "NotFound";
	const loaded = listed ?? item.data;
	const shown = loaded?.conversation.workspaceId === workspace.workspace?.id ? loaded : undefined;
	// Kept while the conversation's people stay the same, so its screen is not
	// handed a new one at every render.
	const people = shown?.people;
	const formerMembers = shown?.formerMembers;
	const found = useMemo((): DirectPlace | undefined => {
		if (!people || formerMembers === undefined) return undefined;
		return { pod: null, conversation: { kind: "direct", people, formerMembers } };
	}, [people, formerMembers]);
	return {
		found,
		isPending: (!listed && item.isPending) || workspace.isPending,
		error: missing ? undefined : item.error,
	};
}

/** How much in the workspace is waiting for the person. */
export type AttentionCounts = {
	/**
	 * Messages written to the person that they have not read: those and
	 * routine results that mention them, and every message in their direct
	 * messages.
	 */
	unreadForYou: number;
	/** Everything in Inbox the person has not read: mentions, messages, runs and collaborations. */
	unreadInInbox: number;
	/** Approvals waiting on the person. */
	waitingApprovals: number;
};

/**
 * How much in the workspace is waiting for the person, which the sidebar and the
 * app's badge count. Mentions, and what else is unread, come from the
 * activity feed, so they are counted among its latest items only; what is
 * unread in direct messages comes from their list, which counts all of it.
 */
export function useAttentionCounts(): AttentionCounts {
	const { data: approvals } = useApprovalInbox();
	const { data: activity } = useActivityFeed();
	const { data: directMessages } = useDirectMessages();
	// A mention in a direct message is counted with the direct message's unread messages.
	const directIds = new Set(directMessages?.items.map((item) => item.conversation.id));
	const mentionsElsewhere =
		activity?.items.filter(
			(item) => item.unread && !directIds.has(item.conversationId) && mentionsYou(item),
		).length ?? 0;
	const unreadInDirectMessages =
		directMessages?.items.reduce((sum, item) => sum + item.unreadMessages, 0) ?? 0;
	return {
		unreadForYou: mentionsElsewhere + unreadInDirectMessages,
		unreadInInbox: activity?.items.filter((item) => item.unread).length ?? 0,
		waitingApprovals: approvals?.waiting.length ?? 0,
	};
}

/** Whether an Inbox item names the person: a mention, or a routine run whose result asks for them. */
function mentionsYou(item: ActivityItem): boolean {
	return item.kind === "mention" || (item.kind === "routine" && item.mentionsYou);
}

/**
 * Records that the person has read the conversation up to its newest message, and
 * clears its dot and its count in the sidebar.
 */
export function useMarkChatRead(conversationId: string | undefined) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: () =>
			conversationId
				? Effect.runPromise(client.api.chats.markRead({ params: { conversationId } }))
				: Promise.resolve(),
		onSuccess: () => refreshChatMarkers(queries, workspaceId),
	});
}

/**
 * Records that the person has read each of `conversationIds` up to its newest
 * message, as Inbox's Mark all as read does, and clears what marks them.
 */
export function useMarkChatsRead() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (conversationIds: readonly string[]) =>
			Effect.runPromise(
				Effect.forEach(
					conversationIds,
					(conversationId) => client.api.chats.markRead({ params: { conversationId } }),
					{ concurrency: MARK_READ_CONCURRENCY, discard: true },
				),
			),
		onSettled: () => refreshChatMarkers(queries, workspaceId),
	});
}

/**
 * Marks one routine run or collaboration read, by its thread, while the
 * window has focus, without reading the rest of the conversation it is in.
 * Checks when the item opens and when the window gains focus.
 */
export function useMarkItemReadWhileSeen(threadId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const { mutate } = useMutation({
		mutationFn: (itemThreadId: string) =>
			Effect.runPromise(client.api.chats.markItemRead({ params: { threadId: itemThreadId } })),
		onSuccess: () => refreshChatMarkers(queries, workspaceId),
	});
	useEffect(() => {
		const markIfFocused = () => {
			if (document.hasFocus()) mutate(threadId);
		};
		markIfFocused();
		window.addEventListener("focus", markIfFocused);
		return () => window.removeEventListener("focus", markIfFocused);
	}, [threadId, mutate]);
}

/** How many conversations Mark all as read marks at once. */
const MARK_READ_CONCURRENCY = 4;

/**
 * Marks the chat read while the person can see `newest`, its latest item: the
 * window has focus and `latestInView` holds. Checks when the chat opens, when
 * `newest` arrives or finishes, when `latestInView` turns true, and when the
 * window gains focus.
 *
 * Focus, not visibility: a window beside the one being worked in is visible,
 * and what arrives there is unseen until the person comes back to it.
 */
export function useMarkReadWhileSeen(
	conversationId: string | undefined,
	newest: ChatMessageItem | undefined,
	latestInView: boolean,
) {
	const { mutate } = useMarkChatRead(conversationId);
	const newestRevision = newest && readRevision(newest);
	useEffect(() => {
		if (!conversationId || newestRevision === undefined || !latestInView) return;
		const markIfFocused = () => {
			if (document.hasFocus()) mutate();
		};
		markIfFocused();
		window.addEventListener("focus", markIfFocused);
		return () => window.removeEventListener("focus", markIfFocused);
	}, [conversationId, newestRevision, latestInView, mutate]);
}

/**
 * What marking a chat read waits on in `item`: a message's id and status, so
 * a reply streaming in marks it once when it arrives and once when it
 * finishes, not at every word.
 */
function readRevision(item: ChatMessageItem): string {
	if (item.kind === "message") return `${item.message.id}:${item.message.status}`;
	// A run seen while it runs is read again once it ends.
	return item.kind === "routine" ? `${item.id}:${item.state}` : item.id;
}

/** Fetches again what shows which chats are unread: the lists, the sidebar and activity. */
export function refreshChatMarkers(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["chat-pod-markers", workspaceId] }),
		queries.invalidateQueries({ queryKey: activityFeedKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: directMessagesKey(workspaceId) }),
	]);
}

/**
 * Fetches every workspace's approvals inbox again, for a request answered
 * where its workspace is not known.
 */
export function refreshEveryApprovalInbox(queries: QueryClient) {
	return queries.invalidateQueries({ queryKey: [APPROVAL_INBOX] });
}

/**
 * Fetches again everything a change in one of the workspace's threads can
 * move: the chats' unread markers and activity, and the approvals inbox.
 */
export function refreshAfterThreadChange(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		refreshChatMarkers(queries, workspaceId),
		queries.invalidateQueries({ queryKey: approvalInboxKey(workspaceId) }),
	]);
}

/**
 * Which kind of conversation is open, and the bot it is with when it has one:
 * a channel's main chat or thread, a bot's task or automation thread, or a
 * direct message between people, one other or a group, with no bot.
 */
export type ConversationKind =
	| { kind: "podChat" }
	| { kind: "botThread"; agent: Agent }
	| ({ kind: "direct" } & DirectPeople);

/** A conversation in a channel. */
export interface ChannelPlace {
	pod: Pod;
	conversation: { kind: "podChat" };
}

/** A bot's task or automation thread, which is in no channel. */
export interface BotPlace {
	pod: null;
	conversation: { kind: "botThread"; agent: Agent };
}

/** A conversation with bots in it: in a channel, or a bot's own. */
export type ConversationPlace = ChannelPlace | BotPlace;

/** A direct message between people, which is in no channel, and who is in it. */
export interface DirectPlace {
	pod: null;
	conversation: Extract<ConversationKind, { kind: "direct" }>;
}

/** The bot a place's conversation is with, if any. */
export function placeAgent(place: { conversation: ConversationKind }): Agent | undefined {
	return place.conversation.kind === "botThread" ? place.conversation.agent : undefined;
}

/**
 * Where the conversation `conversationId` is, in the channel at `podSlug`;
 * `undefined` when there is none or it is not one in that channel. Read from
 * the channel's list, and from the conversation itself only when the list
 * does not have it, as an archived thread.
 */
export function useChannelConversationPlace(
	podSlug: string,
	conversationId: string | undefined,
): { found: ChannelPlace | undefined; isPending: boolean; error: unknown } {
	const pods = usePods();
	const list = useChatList(podSlug);
	const listed = list.data?.chats.some((chat) => chat.conversation.id === conversationId) ?? false;
	const unlisted = useQuery({
		...threadQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const pod = findPod(pods.data, podSlug);
	const inPod =
		listed ||
		(unlisted.data?.thread?.type === "pod_chat" && unlisted.data.thread.podId === pod?.id);
	return {
		found: pod && inPod ? { pod, conversation: { kind: "podChat" } } : undefined,
		isPending:
			pods.isPending || list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: pods.error ?? list.error ?? unlisted.error,
	};
}

/**
 * Where the conversation `conversationId` is when it is one of the bot
 * `agent`'s: one of its tasks or automation threads; `undefined` when it is
 * not.
 */
export function useBotConversationPlace(
	agent: Agent,
	conversationId: string | undefined,
): { found: BotPlace | undefined; isPending: boolean; error: unknown } {
	const list = useBotTasks(agent.id);
	const listed =
		list.data?.tasks.some((item) => item.conversation.id === conversationId) ||
		list.data?.routines.some((item) => item.conversation?.id === conversationId) ||
		false;
	const unlisted = useQuery({
		...threadQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const ours = listed || unlisted.data?.thread?.hostAgentId === agent.id;
	return {
		found: ours ? { pod: null, conversation: { kind: "botThread", agent } } : undefined,
		isPending: list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: list.error ?? unlisted.error,
	};
}

/**
 * Where any conversation `conversationId` is, read from the conversation
 * itself: in a channel, a bot's, or a direct message. For a page, such as
 * Inbox's, whose address names only the conversation.
 */
export function useAnyConversationPlace(conversationId: string): {
	found: ConversationPlace | DirectPlace | undefined;
	isPending: boolean;
	error: unknown;
} {
	const pods = usePods();
	const roster = useAgents();
	const thread = useQuery(threadQuery(conversationId));
	const details = thread.data?.thread;
	const direct = useDirectMessage(conversationId);
	if (details?.type === "direct") return direct;
	const pod = details?.podId ? pods.data?.find((one) => one.id === details.podId) : undefined;
	const agent = details?.hostAgentId
		? roster.agents?.find((one) => one.id === details.hostAgentId)
		: undefined;
	const found: ConversationPlace | undefined = pod
		? { pod, conversation: { kind: "podChat" } }
		: agent
			? { pod: null, conversation: { kind: "botThread", agent } }
			: undefined;
	return {
		found,
		isPending: thread.isPending || pods.isPending || roster.isPending,
		error: thread.error ?? pods.error ?? roster.error,
	};
}

/**
 * The channel's main chat, read from its list when somebody has opened it,
 * and otherwise opened with a request.
 */
export function useOpenPodChat(pod: Pod) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["pod-chat", workspaceId, pod.id],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(chatListQuery(workspaceId, pod.slug));
					return (
						list.chats.find((chat) => chat.conversation.main)?.conversation ??
						Effect.runPromise(
							client.api.chats.openPodChat({ params: { workspace: workspaceId, podId: pod.id } }),
							{ signal },
						)
					);
				}
			: skipToken,
	});
}

/**
 * The automation's own thread, read from its bot's list when it has one, and
 * otherwise opened with a request.
 */
export function useOpenRoutineFeed(agentId: string, routineId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["routine-feed", workspaceId, routineId],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(botTasksQuery(workspaceId, agentId));
					return (
						list.routines.find((item) => item.routine.id === routineId)?.conversation ??
						Effect.runPromise(
							client.api.chats.openRoutineFeed({ params: { workspace: workspaceId, routineId } }),
							{ signal },
						)
					);
				}
			: skipToken,
	});
}

/**
 * Starts loading the conversation an address names: as its page first loads,
 * and for a link the pointer is on, so it is on screen when the click lands.
 * A failure is left for the screen's own queries to meet and show.
 */
export function prefetchConversation(queries: QueryClient, conversationId: string): void {
	void queries.prefetchInfiniteQuery(chatMessagesQuery(conversationId));
	void queries.prefetchInfiniteQuery(chatHistoryQuery(conversationId));
	void queries.prefetchQuery(threadQuery(conversationId));
}

/** The conversation, a page at a time, newest page first. */
function chatMessagesQuery(conversationId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: ["chat-messages", conversationId],
		queryFn: conversationId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.messages({
							params: { conversationId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

/** The threads opened beside the conversation, a page at a time, newest activity first. */
function chatHistoryQuery(conversationId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: ["chat-history", conversationId],
		refetchInterval: (current) =>
			current.state.data?.pages.some((page) =>
				page?.items.some((entry) => entry.status === "queued" || entry.status === "running"),
			)
				? RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS
				: false,
		queryFn: conversationId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.history({
							params: { conversationId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

export function useChatMessages(conversationId: string | undefined) {
	const query = useInfiniteQuery(chatMessagesQuery(conversationId));
	const items = query.data?.pages
		.slice()
		.reverse()
		.flatMap((page) => page?.items ?? []);
	return { ...query, items: items ?? [] };
}

export function useChatHistory(conversationId: string | undefined) {
	const query = useInfiniteQuery(chatHistoryQuery(conversationId));
	return {
		...query,
		entries: query.data?.pages.flatMap((page) => page?.items ?? []) ?? [],
	};
}

/**
 * A message to send, with the whole quote it answers and the files it
 * attaches, so it shows both before the API answers.
 */
export type MessageToSend = Omit<NewMessage, "replyTo" | "attachments"> & {
	replyTo?: MessageReplyTo;
	files?: readonly FilePart[];
};

export function useSendChatMessage(conversationId: string, user: SessionUser) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: async ({ replyTo, files = [], ...message }: MessageToSend) => {
			const payload: NewMessage = {
				...message,
				...(replyTo && { replyTo: replyTo.id }),
				...(files.length > 0 && { attachments: files.map((file) => file.id) }),
			};
			return Effect.runPromise(client.api.chats.send({ params: { conversationId }, payload }));
		},
		onMutate: async (input) => {
			await queries.cancelQueries({ queryKey: ["chat-messages", conversationId] });
			const optimistic: ChatMessageItem = {
				kind: "message",
				message: {
					id: input.id,
					threadId: conversationId,
					author: personParticipantOf(user),
					kind: "text",
					status: "complete",
					parts: [
						...(input.message === "" ? [] : [{ type: "text" as const, text: input.message }]),
						...(input.files ?? []),
					],
					content: input.message,
					...(input.replyTo ? { replyTo: input.replyTo } : {}),
					createdAt: timestampAfter(
						queries.getQueryData<ThreadDetails>(["thread", conversationId])?.messages ?? [],
					),
				},
			};
			queries.setQueryData(["chat-optimistic", conversationId], (items: ChatMessageItem[] = []) => [
				...items,
				optimistic,
			]);
		},
		onSettled: async (_result, _error, input) => {
			queries.setQueryData<ChatMessageItem[]>(["chat-optimistic", conversationId], (items) =>
				items?.filter((item) => item.kind !== "message" || item.message.id !== input.id),
			);
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages", conversationId] }),
				queries.invalidateQueries({ queryKey: ["chat-history", conversationId] }),
				queries.invalidateQueries({ queryKey: ["thread", conversationId] }),
				queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
			]);
		},
	});
}

/** What the composer says when the API did not start a task. */
export const TASK_NOT_STARTED = "The task was not started. Your draft is still here.";

/**
 * How starting a task from a draft went: started; refused by the API; or not
 * sent, because the draft has no words to title it.
 */
export type TaskStart =
	| { outcome: "started"; task: StartedThread }
	| { outcome: "refused" }
	| { outcome: "notSent" };

/**
 * Starts tasks with the bot `agentId`, each with a draft as its first message;
 * files are added once it has started. The bot's list shows each task once it
 * has.
 */
export function useTaskStarter(agentId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const startTask = useMutation({
		mutationFn: (payload: NewThread) =>
			Effect.runPromise(client.api.chats.startTask({ params: { agentId }, payload })),
		onSettled: () => queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId, agentId] }),
	});
	async function start(draft: string): Promise<TaskStart> {
		const message = draft.trim();
		if (startTask.isPending || message === "") return { outcome: "notSent" };
		try {
			const task = await startTask.mutateAsync({ id: uuidv4(), message });
			return { outcome: "started", task };
		} catch {
			return { outcome: "refused" };
		}
	}
	return { start, isPending: startTask.isPending };
}

/**
 * Starts the task in which a bot its maker just made interviews them, when
 * the bot is due one; resolves to the task, or null.
 */
export function useStartInterview() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (agentId: string) =>
			Effect.runPromise(client.api.chats.startInterview({ params: { agentId } })),
		onSettled: (_task, _error, agentId) =>
			queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId, agentId] }),
	});
}

/** Marks the task done, or reopens it. The task and its bot's list show it once it has. */
export function useSetDone(conversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (done: boolean) =>
			Effect.runPromise(
				done
					? client.api.chats.markDone({ params: { conversationId } })
					: client.api.chats.reopen({ params: { conversationId } }),
			),
		onSettled: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["thread", conversationId] }),
				queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
			]),
	});
}

/**
 * What a routine's own thread does with its routine: run it again, which
 * turns on one that paused itself after failing, pause or resume it, and
 * rename it.
 * `pending` is shared by every control of the routine on screen, so none
 * starts another change while one is on its way. The thread, its page and
 * its bot's list are fetched again after each.
 */
export function useRoutineControls(
	conversationId: string,
	routine: { id: string; agentId: string },
) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const actions = useRoutineActions();
	const mutationKey = ["routine-controls", routine.id];
	const refresh = () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: ["thread", conversationId] }),
			queries.invalidateQueries({ queryKey: ["chat-messages", conversationId] }),
			queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
		]);
	const scope = { agentId: routine.agentId, routineId: routine.id };
	const runAgain = useMutation({
		mutationKey,
		mutationFn: () => actions.run.mutateAsync(scope),
		onSuccess: refresh,
	});
	const update = useMutation({
		mutationKey,
		mutationFn: (json: RoutineUpdate) => actions.update.mutateAsync({ ...scope, json }),
		onSuccess: refresh,
	});
	return {
		runAgain: () => runAgain.mutateAsync(),
		setPaused: (paused: boolean) => update.mutateAsync({ state: paused ? "paused" : "enabled" }),
		/** Renames the routine, and its thread with it. */
		rename: (name: string) => update.mutateAsync({ name }),
		pending: useIsMutating({ mutationKey }) > 0,
	};
}

/** Starts a thread in the channel, named `name`. The channel's list shows it once it has. */
export function useStartChat(pod: Pod) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (name: string) =>
			Effect.runPromise(
				client.api.chats.startChat({ params: { podId: pod.id }, payload: { name } }),
			),
		onSettled: () => queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
	});
}

/** Renames the channel's thread `conversationId`. The channel's list and the thread show it once it has. */
export function useRenameChat(conversationId: string) {
	const refresh = useRefreshChat(conversationId);
	return useMutation({
		mutationFn: (name: string) =>
			Effect.runPromise(
				client.api.chats.renameChat({ params: { conversationId }, payload: { name } }),
			),
		onSettled: refresh,
	});
}

/** Archives the channel's thread `conversationId`, which takes it off the channel's list. */
export function useArchiveChat(conversationId: string) {
	const refresh = useRefreshChat(conversationId);
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(client.api.chats.archiveChat({ params: { conversationId } })),
		onSettled: refresh,
	});
}

/** Fetches again what shows a channel's thread as it is: the thread, and the channel's list. */
function useRefreshChat(conversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: ["thread", conversationId] }),
			queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		]);
}

/**
 * A timestamp for a message being sent that sorts after every message shown:
 * now, or a millisecond after the newest one if this browser's clock is behind
 * the server's.
 */
function timestampAfter(messages: readonly { createdAt: string }[]): string {
	const times = [Date.now(), ...messages.map(({ createdAt }) => Date.parse(createdAt) + 1)];
	return new Date(Math.max(...times)).toISOString();
}

/** When a chat item happened, which puts items in order. */
export function chatItemCreatedAt(item: ChatMessageItem): string {
	return item.kind === "message" ? item.message.createdAt : item.createdAt;
}

export function useOptimisticChatItems(conversationId: string | undefined): ChatMessageItem[] {
	const query = useQuery<ChatMessageItem[]>({
		queryKey: ["chat-optimistic", conversationId],
		queryFn: skipToken,
		initialData: [],
	});
	return query.data ?? [];
}

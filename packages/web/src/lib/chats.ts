import {
	type Agent,
	type ChatMessageItem,
	type FilePart,
	handleFromName,
	type MessageReplyTo,
	type NewMessage,
	type NewThread,
	type Pod,
	type SessionUser,
	type ThreadDetails,
} from "@sugabots/contracts";
import {
	infiniteQueryOptions,
	type QueryClient,
	queryOptions,
	skipToken,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect } from "react";
import { client } from "@/api.ts";
import { useAgents } from "@/lib/agents.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { threadQuery } from "@/lib/threads.ts";
import { useWorkspace } from "@/lib/workspace.ts";

const PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

/**
 * A pod's conversation list, by the pod's slug: what a chat page's address
 * names, so a page can ask for it before it knows the pod's id.
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

/** The conversation list for a pod, by its slug: one row per bot, newest first. */
export function useChatList(podSlug: string | undefined) {
	return useQuery(chatListQuery(useWorkspace().workspace?.id, podSlug));
}

/** How each pod stands for the rail: its unread messages, and whether any chat waits on the person. */
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

/** How much in the workspace is waiting for the person. */
export type AttentionCounts = {
	/** Messages that mention the person and that they have not read. */
	unreadMentions: number;
	/** Approvals waiting on the person. */
	waitingApprovals: number;
};

/**
 * How much in the workspace is waiting for the person, which the rail and the
 * app's badge count. Unread mentions come from the activity feed, so they are
 * counted among its latest items only.
 */
export function useAttentionCounts(): AttentionCounts {
	const { data: approvals } = useApprovalInbox();
	const { data: activity } = useActivityFeed();
	return {
		unreadMentions:
			activity?.items.filter((item) => item.kind === "mention" && item.unread).length ?? 0,
		waitingApprovals: approvals?.waiting.length ?? 0,
	};
}

/**
 * Records that the person has read the conversation up to its newest message, and
 * clears its dot and its count on the rail.
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
	return item.kind === "message" ? `${item.message.id}:${item.message.status}` : item.id;
}

/** Fetches again what shows which chats are unread: the lists, the rail and activity. */
export function refreshChatMarkers(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["chat-pod-markers", workspaceId] }),
		queries.invalidateQueries({ queryKey: activityFeedKey(workspaceId) }),
	]);
}

/**
 * Fetches every workspace's approvals inbox again, for a request answered
 * where only its pod is known.
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
 * The bot's newest conversation in the pod, for an address that names the bot
 * rather than the conversation. It is read from the pod's conversation list,
 * which the screen loads anyway, so one that exists costs no request of its
 * own. Only a bot the list shows without one, because it never had one or it
 * began after the list loaded, has one opened with a request.
 */
export function useOpenConversation(pod: Pod, hostAgentId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["conversation-with", workspaceId, pod.id, hostAgentId],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(chatListQuery(workspaceId, pod.slug));
					const listed = list.items.find((item) => item.agent?.id === hostAgentId)?.conversation;
					return (
						listed ??
						Effect.runPromise(
							client.api.chats.open({
								params: { workspace: workspaceId },
								payload: { podId: pod.id, hostAgentId },
							}),
							{ signal },
						)
					);
				}
			: skipToken,
	});
}

/**
 * A conversation's pod, and the bot it is with: null when it is the pod's chat
 * or a thread between people, which `isPodChat` tells apart.
 */
export interface ConversationPlace {
	pod: Pod;
	agent: Agent | null;
	isPodChat: boolean;
}

/**
 * Where the conversation `conversationId` is, in the pod at `podSlug`;
 * `undefined` when it is not one in that pod. Read from the pod's
 * conversation list, which the screen loads anyway, and from the conversation
 * itself only when the list does not have it, so the screen does not wait on
 * the conversation to know whose it is.
 */
export function useConversationPlace(
	podSlug: string,
	conversationId: string,
): { found: ConversationPlace | undefined; isPending: boolean; error: unknown } {
	const pods = usePods();
	const roster = useAgents();
	const list = useChatList(podSlug);
	const listedPodChat = list.data?.podChat?.conversation.id === conversationId;
	const listedThread = list.data?.items.find((item) => item.conversation.id === conversationId);
	const listed = listedPodChat || listedThread !== undefined;
	const unlisted = useQuery({
		...threadQuery(conversationId),
		enabled: list.isSuccess && !listed,
	});
	const pod = findPod(pods.data, podSlug);
	const thread = unlisted.data?.thread?.podId === pod?.id ? unlisted.data?.thread : undefined;
	const isPodChat = listedPodChat || thread?.type === "pod_chat";
	const isThread = listedThread !== undefined || thread?.type === "conversation";
	const hostAgentId = listedThread ? listedThread.conversation.hostAgentId : thread?.hostAgentId;
	const agent = roster.agents?.find((candidate) => candidate.id === hostAgentId) ?? null;
	// A thread with a bot waits for the roster to have the bot.
	const known = isPodChat || (isThread && (hostAgentId === null || agent !== null));
	return {
		found: pod && known ? { pod, agent, isPodChat } : undefined,
		isPending:
			pods.isPending ||
			roster.isPending ||
			list.isPending ||
			(list.isSuccess && !listed && unlisted.isPending),
		error: pods.error ?? roster.error ?? list.error ?? unlisted.error,
	};
}

/**
 * The pod's chat, read from its conversation list when somebody has opened it,
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
						list.podChat?.conversation ??
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
					author: {
						kind: "person",
						id: user.id,
						name: user.name,
						email: user.email,
						handle: handleFromName(user.name),
						image: user.image,
					},
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
			]);
		},
	});
}

/** A thread to start, with the files uploaded to the pod's chat that its first message attaches. */
export type ThreadToStart = Omit<NewThread, "attachments"> & { files?: readonly FilePart[] };

/**
 * Starts a thread from the pod's chat `podChatId` with its first message, for
 * the bot it names. The pod's chat and its list show the thread once it has.
 */
export function useStartThread(podChatId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: ({ files = [], ...thread }: ThreadToStart) => {
			const payload: NewThread = {
				...thread,
				...(files.length > 0 && { attachments: files.map((file) => file.id) }),
			};
			return Effect.runPromise(
				client.api.chats.startThread({ params: { conversationId: podChatId }, payload }),
			);
		},
		onSettled: () => refreshPodChat(queries, workspaceId, podChatId),
	});
}

/**
 * Starts a thread between people from a message in the pod's chat
 * `podChatId`, or finds the one it has.
 */
export function useThreadFrom(podChatId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (messageId: string) =>
			Effect.runPromise(client.api.chats.threadFrom({ params: { messageId } })),
		onSettled: () => refreshPodChat(queries, workspaceId, podChatId),
	});
}

/** Marks the conversation done, or reopens it. Its thread and the pod's list show it once it has. */
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
				queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
			]),
	});
}

/** Fetches again what shows the threads started from a pod's chat: the chat and the pod's list. */
function refreshPodChat(queries: QueryClient, workspaceId: string | undefined, podChatId: string) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["chat-messages", podChatId] }),
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

export function useOptimisticChatItems(conversationId: string | undefined): ChatMessageItem[] {
	const query = useQuery<ChatMessageItem[]>({
		queryKey: ["chat-optimistic", conversationId],
		queryFn: skipToken,
		initialData: [],
	});
	return query.data ?? [];
}

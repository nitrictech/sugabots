import {
	type Chat,
	type ChatList,
	type ChatMessageItem,
	handleFromName,
	type NewMessage,
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
import { agentsQuery, findPodAgent } from "@/lib/agents.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { findPod, podsQuery } from "@/lib/pods.ts";
import { threadQuery } from "@/lib/threads.ts";
import { useWorkspace, workspacesQuery } from "@/lib/workspace.ts";

/** Messages, or side threads, a page of the chat holds. */
export const CHAT_PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

function chatListQuery(workspaceId: string | undefined, pod: string | undefined) {
	return queryOptions({
		queryKey: ["chat-list", workspaceId, pod],
		queryFn:
			workspaceId && pod
				? ({ signal }) =>
						Effect.runPromise(
							client.api.chats.list({ params: { workspace: workspaceId }, query: { pod } }),
							{ signal },
						)
				: skipToken,
	});
}

/** The conversation list for a pod, by its id: one row per bot, newest first. */
export function useChatList(pod: string | undefined) {
	return useQuery(chatListQuery(useWorkspace().workspace?.id, pod));
}

/** How each pod stands for the rail: its unread chats, and whether any waits on the person. */
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

/**
 * Records that the person has read the chat up to its newest message, and
 * clears its dot and its count on the rail.
 */
export function useMarkChatRead(chatId: string | undefined) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: () =>
			chatId
				? Effect.runPromise(client.api.chats.markRead({ params: { chatId } }))
				: Promise.resolve(),
		onSuccess: () => refreshChatMarkers(queries, workspaceId),
	});
}

/**
 * Marks the chat read while it is on screen: when it opens, when `newest`
 * changes, and when its tab comes back into view. `newest` names the latest
 * message and how it stands, so a reply streaming in marks it once it
 * arrives and once it finishes, not at every word.
 */
export function useReadWhileShown(chatId: string | undefined, newest: string | undefined) {
	const { mutate } = useMarkChatRead(chatId);
	useEffect(() => {
		if (!chatId || newest === undefined) return;
		const markIfShown = () => {
			if (document.visibilityState === "visible") mutate();
		};
		markIfShown();
		document.addEventListener("visibilitychange", markIfShown);
		return () => document.removeEventListener("visibilitychange", markIfShown);
	}, [chatId, newest, mutate]);
}

/** Fetches again what shows which chats are unread or waiting: the lists and the rail. */
export function refreshChatMarkers(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["chat-pod-markers", workspaceId] }),
	]);
}

/**
 * The chat with `hostAgentId` in the pod. It is read from the pod's
 * conversation list, which the screen loads anyway, so a chat that exists
 * costs no request of its own. Only a bot whose chat the list lacks, because
 * it was never opened or was opened after the list loaded, has one opened
 * with a request.
 */
export function useChat(podId: string | undefined, hostAgentId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: chatKey(workspaceId, podId, hostAgentId),
		queryFn:
			workspaceId && podId
				? async ({ signal }) => {
						const list = await queries.ensureQueryData(chatListQuery(workspaceId, podId));
						const listed = listedChat(list, hostAgentId);
						return (
							listed ??
							Effect.runPromise(
								client.api.chats.getOrCreate({
									params: { workspace: workspaceId },
									payload: { podId, hostAgentId },
								}),
								{ signal },
							)
						);
					}
				: skipToken,
	});
}

/** The chat with `hostAgentId` in a pod's conversation list, when the list has it. */
function listedChat(list: ChatList, hostAgentId: string): Chat | undefined {
	return list.items.find((item) => item.agent.id === hostAgentId)?.chat ?? undefined;
}

function chatKey(workspaceId: string | undefined, podId: string | undefined, hostAgentId: string) {
	return ["chat", workspaceId, podId, hostAgentId] as const;
}

/**
 * Messages the main thread's details carry. The thread's events change only
 * messages its details hold, and the chat's newest page has to stay live, so
 * the details carry a page's worth: fewer would leave a reply that newer
 * messages pushed past them still writing on screen.
 */
export const LIVE_MESSAGE_LIMIT = CHAT_PAGE_SIZE;

/**
 * Starts loading the chat an address names: as its page first loads, and for a
 * link the pointer is on, so the chat is on screen when the click lands. A page
 * whose workspace's pods are not cached yet first asks for them, its agents and
 * its conversation list at once. It never opens a chat nobody has: that waits for the screen.
 */
export async function prefetchChat(
	queries: QueryClient,
	address: { workspace: string; pod: string; agent: string },
): Promise<void> {
	const workspace = queries
		.getQueryData(workspacesQuery.queryKey)
		?.find((one) => one.slug === address.workspace);
	if (!workspace) return;
	if (!queries.getQueryData(podsQuery(workspace.id).queryKey)) {
		await loadChatPage(queries, workspace.id, address.pod);
	}
	const found = findPodAgent(
		queries.getQueryData(podsQuery(workspace.id).queryKey),
		queries.getQueryData(agentsQuery(workspace.id).queryKey),
		address.pod,
		address.agent,
	);
	if (!found) return;
	const list = queries.getQueryData(chatListQuery(workspace.id, found.pod.id).queryKey);
	const chat = list && listedChat(list, found.agent.id);
	if (!chat) return;
	const key = chatKey(workspace.id, found.pod.id, found.agent.id);
	if (!queries.getQueryData(key)) queries.setQueryData(key, chat);
	void queries.prefetchInfiniteQuery(chatMessagesQuery(chat.id));
	void queries.prefetchInfiniteQuery(chatHistoryQuery(chat.id));
	void queries.prefetchQuery(threadQuery(chat.mainThreadId, LIVE_MESSAGE_LIMIT));
}

/**
 * On a chat page's first load, asks for its workspace's pods and agents and the
 * pod's conversation list side by side: the list by the pod's slug, since its
 * id is in the pods still on their way. The list is filed under the pod's id
 * as soon as the pods land, so the screen's own query for it waits on this
 * request rather than sending another. A failure is left for the screen's own
 * queries to meet and show.
 */
async function loadChatPage(
	queries: QueryClient,
	workspaceId: string,
	podSlug: string,
): Promise<void> {
	const list = Effect.runPromise(
		client.api.chats.list({ params: { workspace: workspaceId }, query: { pod: podSlug } }),
	);
	list.catch(() => {});
	const agents = queries.ensureQueryData(agentsQuery(workspaceId)).catch(() => undefined);
	const pods = await queries.ensureQueryData(podsQuery(workspaceId)).catch(() => undefined);
	const pod = pods && findPod(pods, podSlug);
	if (!pod) return;
	// Filed the moment the pods land, before the screen they let render asks for it by id.
	await Promise.all([
		queries.prefetchQuery({
			queryKey: chatListQuery(workspaceId, pod.id).queryKey,
			queryFn: () => list,
		}),
		agents,
	]);
}

/** The chat's main conversation, a page at a time, newest page first. */
function chatMessagesQuery(chatId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: ["chat-messages", chatId],
		queryFn: chatId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.messages({
							params: { chatId },
							query: { limit: CHAT_PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

/** The chat's side threads, a page at a time, newest activity first. */
function chatHistoryQuery(chatId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: ["chat-history", chatId],
		refetchInterval: (current) =>
			current.state.data?.pages.some((page) =>
				page?.items.some((entry) => entry.status === "queued" || entry.status === "running"),
			)
				? RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS
				: false,
		queryFn: chatId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.history({
							params: { chatId },
							query: { limit: CHAT_PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

export function useChatMessages(chatId: string | undefined) {
	const query = useInfiniteQuery(chatMessagesQuery(chatId));
	const items = query.data?.pages
		.slice()
		.reverse()
		.flatMap((page) => page?.items ?? []);
	return { ...query, items: items ?? [] };
}

export function useChatHistory(chatId: string | undefined) {
	const query = useInfiniteQuery(chatHistoryQuery(chatId));
	return {
		...query,
		entries: query.data?.pages.flatMap((page) => page?.items ?? []) ?? [],
	};
}

export function useSendChatMessage(chat: Chat | undefined, user: SessionUser) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: async (input: NewMessage) => {
			if (!chat) throw new NotReadyError();
			return Effect.runPromise(
				client.api.chats.send({ params: { chatId: chat.id }, payload: input }),
			);
		},
		onMutate: async (input) => {
			if (!chat) return;
			await queries.cancelQueries({ queryKey: ["chat-messages", chat.id] });
			const optimistic: ChatMessageItem = {
				kind: "message",
				message: {
					id: input.id,
					threadId: chat.mainThreadId,
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
					parts: [{ type: "text", text: input.message }],
					content: input.message,
					createdAt: timestampAfter(
						queries.getQueryData<ThreadDetails>(["thread", chat.mainThreadId])?.messages ?? [],
					),
				},
			};
			queries.setQueryData(["chat-optimistic", chat.id], (items: ChatMessageItem[] = []) => [
				...items,
				optimistic,
			]);
		},
		onSettled: async (_result, _error, input) => {
			if (!chat) return;
			queries.setQueryData<ChatMessageItem[]>(["chat-optimistic", chat.id], (items) =>
				items?.filter((item) => item.kind !== "message" || item.message.id !== input.id),
			);
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages", chat.id] }),
				queries.invalidateQueries({ queryKey: ["chat-history", chat.id] }),
				queries.invalidateQueries({ queryKey: ["thread", chat.mainThreadId] }),
				queries.invalidateQueries({ queryKey: ["chat-list", chat.workspaceId] }),
			]);
		},
	});
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

export function useOptimisticChatItems(chatId: string | undefined): ChatMessageItem[] {
	const query = useQuery<ChatMessageItem[]>({
		queryKey: ["chat-optimistic", chatId],
		queryFn: skipToken,
		initialData: [],
	});
	return query.data ?? [];
}

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
	type StartedThread,
	type ThreadDetails,
} from "@sugabots/contracts";
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
import { useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { useAgents } from "@/lib/agents.ts";
import type { ComposerAttachments } from "@/lib/composer-attachments.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useRoutineActions } from "@/lib/routines.ts";
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

/** The conversation list for a pod, by its slug: its chats, its threads newest first, and its routines. */
export function useChatList(podSlug: string | undefined) {
	return useQuery(chatListQuery(useWorkspace().workspace?.id, podSlug));
}

/** How each pod stands for the pod menu: its unread messages, and whether any chat waits on the person. */
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
	/** Everything in Inbox the person has not read: mentions, messages, runs and collaborations. */
	unreadInInbox: number;
	/** Approvals waiting on the person. */
	waitingApprovals: number;
};

/**
 * How much in the workspace is waiting for the person, which the sidebar and the
 * app's badge count. What is unread comes from the activity feed, so it is
 * counted among its latest items only.
 */
export function useAttentionCounts(): AttentionCounts {
	const { data: approvals } = useApprovalInbox();
	const { data: activity } = useActivityFeed();
	return {
		unreadMentions:
			activity?.items.filter((item) => item.kind === "mention" && item.unread).length ?? 0,
		unreadInInbox: activity?.items.filter((item) => item.unread).length ?? 0,
		waitingApprovals: approvals?.waiting.length ?? 0,
	};
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
	return item.kind === "message" ? `${item.message.id}:${item.message.status}` : item.id;
}

/** Fetches again what shows which chats are unread: the lists, the sidebar and activity. */
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
 * The bot's channel in the pod, for an address that names the bot rather
 * than the channel. It is read from the pod's conversation list, which the
 * screen loads anyway, so one that exists costs no request of its own. Only
 * a bot the list shows without one, because nobody opened it yet or it was
 * opened after the list loaded, has one opened with a request.
 */
export function useOpenBotChannel(pod: Pod, hostAgentId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["bot-channel", workspaceId, pod.id, hostAgentId],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(chatListQuery(workspaceId, pod.slug));
					const listed = list.channels.find(
						(item) => item.conversation.hostAgentId === hostAgentId,
					)?.conversation;
					if (listed) return listed;
					const opened = await Effect.runPromise(
						client.api.chats.openBotChannel({
							params: { workspace: workspaceId },
							payload: { podId: pod.id, hostAgentId },
						}),
						{ signal },
					);
					// The list was loaded without the channel just opened.
					void queries.invalidateQueries({ queryKey: ["chat-list", workspaceId, pod.slug] });
					return opened;
				}
			: skipToken,
	});
}

/** Which kind of conversation is open, and the bot it is with when it has one. */
export type ConversationKind =
	| { kind: "podChat" }
	| { kind: "botChannel"; agent: Agent }
	| { kind: "botThread"; agent: Agent }
	| { kind: "peopleThread" };

/** A conversation's pod, and which kind of conversation it is. */
export interface ConversationPlace {
	pod: Pod;
	conversation: ConversationKind;
}

/**
 * Where the conversation `conversationId` is, in the pod at `podSlug`;
 * `undefined` when there is none or it is not one in that pod. Read from the
 * pod's conversation list, which the screen loads anyway, and from the
 * conversation itself only when the list does not have it, so the screen does
 * not wait on the conversation to know whose it is.
 */
export function useConversationPlace(
	podSlug: string,
	conversationId: string | undefined,
): { found: ConversationPlace | undefined; isPending: boolean; error: unknown } {
	const pods = usePods();
	const roster = useAgents();
	const list = useChatList(podSlug);
	const listedPodChat =
		list.data?.chats.some((chat) => chat.conversation.id === conversationId) ?? false;
	const listedChannel = list.data?.channels.find((item) => item.conversation.id === conversationId);
	const listedThread =
		list.data?.threads.find((item) => item.conversation.id === conversationId) ??
		list.data?.routines.find((item) => item.conversation?.id === conversationId);
	const listed = listedPodChat || listedChannel !== undefined || listedThread !== undefined;
	const unlisted = useQuery({
		...threadQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const pod = findPod(pods.data, podSlug);
	const thread = unlisted.data?.thread?.podId === pod?.id ? unlisted.data?.thread : undefined;
	const hostAgentId =
		listedChannel?.agent.id ??
		(listedThread ? (listedThread.agent?.id ?? null) : thread?.hostAgentId);
	const agent =
		roster.agents?.find((candidate) => candidate.id === hostAgentId) ?? listedChannel?.agent;
	const conversation = conversationKindOf({
		isPodChat: listedPodChat || thread?.type === "pod_chat",
		isBotChannel: listedChannel !== undefined || thread?.type === "bot_channel",
		isThread:
			listedThread !== undefined ||
			thread?.type === "conversation" ||
			thread?.type === "routine_feed",
		hostAgentId,
		agent,
	});
	return {
		found: pod && conversation ? { pod, conversation } : undefined,
		isPending:
			pods.isPending ||
			roster.isPending ||
			list.isPending ||
			(list.isSuccess && !listed && unlisted.isPending),
		error: pods.error ?? roster.error ?? list.error ?? unlisted.error,
	};
}

/** Which kind a conversation is, once enough is known to say; a channel or thread with a bot waits for the bot. */
function conversationKindOf(known: {
	isPodChat: boolean;
	isBotChannel: boolean;
	isThread: boolean;
	hostAgentId: string | null | undefined;
	agent: Agent | undefined;
}): ConversationKind | undefined {
	if (known.isPodChat) return { kind: "podChat" };
	if (known.isBotChannel) return known.agent && { kind: "botChannel", agent: known.agent };
	if (!known.isThread) return undefined;
	if (known.hostAgentId === null) return { kind: "peopleThread" };
	return known.agent && { kind: "botThread", agent: known.agent };
}

/**
 * The pod's first chat, read from its conversation list when somebody has
 * opened it, and otherwise opened with a request.
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
 * The routine's own thread, read from its pod's list when it has one, and
 * otherwise opened with a request.
 */
export function useOpenRoutineFeed(pod: Pod, routineId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["routine-feed", workspaceId, routineId],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(chatListQuery(workspaceId, pod.slug));
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
function useStartThread(podChatId: string | undefined) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: ({ files = [], ...thread }: ThreadToStart) => {
			if (!podChatId) throw new Error("A thread was started before the pod's chat had opened");
			const payload: NewThread = {
				...thread,
				...(files.length > 0 && { attachments: files.map((file) => file.id) }),
			};
			return Effect.runPromise(
				client.api.chats.startThread({ params: { conversationId: podChatId }, payload }),
			);
		},
		onSettled: () => podChatId && refreshPodChat(queries, workspaceId, podChatId),
	});
}

/** What the composer says when the API did not start a thread. */
export const THREAD_NOT_STARTED = "The thread was not started. Your draft is still here.";

/**
 * How starting a thread from a draft went: started; refused by the API, with
 * its files put back; or not sent, because the draft has no words to title it
 * or its files are not ready.
 */
export type ThreadStart =
	| { outcome: "started"; thread: StartedThread }
	| { outcome: "refused" }
	| { outcome: "notSent" };

/**
 * Starts threads from the pod's chat `podChatId`, each with a draft as its
 * first message and the files staged in `attachments`.
 */
export function useThreadStarter(podChatId: string | undefined, attachments: ComposerAttachments) {
	const startThread = useStartThread(podChatId);
	async function start(
		draft: string,
		options: { hostAgentId?: string; replyTo?: string } = {},
	): Promise<ThreadStart> {
		const message = draft.trim();
		if (!podChatId || startThread.isPending || message === "") return { outcome: "notSent" };
		const files = attachments.takeForSending(draft);
		if (!files) return { outcome: "notSent" };
		try {
			const thread = await startThread.mutateAsync({
				id: uuidv4(),
				message,
				files: files.parts,
				...options,
			});
			return { outcome: "started", thread };
		} catch (failure) {
			files.putBack(failure);
			return { outcome: "refused" };
		}
	}
	return { start, isPending: startThread.isPending };
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

/**
 * What a routine's own thread does with its routine: run it again, which
 * turns on one that paused itself after failing, and pause or resume it.
 * `pending` is shared by every control of the routine on screen, so none
 * starts another change while one is on its way. The thread, its page and
 * the pod's list are fetched again after each.
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
			queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		]);
	const scope = { agentId: routine.agentId, routineId: routine.id };
	const runAgain = useMutation({
		mutationKey,
		mutationFn: () => actions.run.mutateAsync(scope),
		onSuccess: refresh,
	});
	const setPaused = useMutation({
		mutationKey,
		mutationFn: (paused: boolean) =>
			actions.update.mutateAsync({ ...scope, json: { state: paused ? "paused" : "enabled" } }),
		onSuccess: refresh,
	});
	return {
		runAgain: () => runAgain.mutateAsync(),
		setPaused: (paused: boolean) => setPaused.mutateAsync(paused),
		pending: useIsMutating({ mutationKey }) > 0,
	};
}

/** Starts another chat in the pod, named `name`. The pod's list shows it once it has. */
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

/** Renames the pod's chat `conversationId`. The pod's list and the chat show it once it has. */
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

/** Archives the pod's chat `conversationId`, which takes it off the pod's list. */
export function useArchiveChat(conversationId: string) {
	const refresh = useRefreshChat(conversationId);
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(client.api.chats.archiveChat({ params: { conversationId } })),
		onSettled: refresh,
	});
}

/** Fetches again what shows a pod's chat as it is: the chat, and the pod's list. */
function useRefreshChat(conversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: ["thread", conversationId] }),
			queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		]);
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

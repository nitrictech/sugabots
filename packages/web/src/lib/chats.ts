import type {
	Chat,
	ChatMessageItem,
	NewMessage,
	SessionUser,
	ThreadDetails,
} from "@sugabots/contracts";
import {
	skipToken,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

const PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

/** The conversation list for a pod, by its id: one row per bot, newest first. */
export function useChatList(pod: string | undefined) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
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

export function useChat(podId: string | undefined, hostAgentId: string) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["chat", workspaceId, podId, hostAgentId],
		queryFn:
			workspaceId && podId
				? ({ signal }) =>
						Effect.runPromise(
							client.api.chats.getOrCreate({
								params: { workspace: workspaceId },
								payload: { podId, hostAgentId },
							}),
							{ signal },
						)
				: skipToken,
	});
}

export function useChatMessages(chatId: string | undefined) {
	const query = useInfiniteQuery({
		queryKey: ["chat-messages", chatId],
		queryFn: chatId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.messages({
							params: { chatId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
	const items = query.data?.pages
		.slice()
		.reverse()
		.flatMap((page) => page?.items ?? []);
	return { ...query, items: items ?? [] };
}

export function useChatHistory(chatId: string | undefined) {
	const query = useInfiniteQuery({
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
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
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
						handle: user.name
							.toLocaleLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/(^-|-$)/g, ""),
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

import {
	type ChatDetails,
	DEFAULT_CHAT_HISTORY_LIMIT,
	type Message,
	type ToolApprovalDecision,
} from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { mergeChatMessages } from "@/lib/chat-events.ts";
import { refreshEveryWorkspaceApprovals } from "@/lib/chats.ts";

/**
 * A message fetched while it streams is behind the deltas already applied: the
 * row is flushed about once a second. Taking the fetched text would make the
 * bubble jump back, so the streamed text stays when it is the longer one.
 */
function keepStreamedText(current: ChatDetails): (fetched: Message) => Message {
	return (fetched) => {
		const streamed = current.messages.find((message) => message.id === fetched.id);
		if (
			!streamed ||
			fetched.status !== "writing" ||
			streamed.content.length <= fetched.content.length ||
			!streamed.content.startsWith(fetched.content)
		) {
			return fetched;
		}
		return { ...fetched, content: streamed.content, parts: streamed.parts };
	};
}

/**
 * How much of its bot's context window a chat fills; null until a reply in it
 * has been measured. Asked for only while the details panel is open, and
 * refreshed by the chat's events.
 */
export function useChatContext(chatId: string) {
	return useQuery({
		queryKey: ["chat-context", chatId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.chats.context({ params: { chatId } }), { signal }),
	});
}

/**
 * A chat and a page of its messages as it is fetched, merged into what the
 * cache already holds of it.
 */
export function chatQuery(chatId: string | undefined) {
	const queryKey = ["chat", chatId] as const;
	return queryOptions<ChatDetails>({
		queryKey,
		// Nothing hears the chat's events while it is off screen, and a new
		// stream starts from now, so a cached copy may have missed a reply finishing.
		refetchOnMount: "always",
		queryFn: chatId
			? async ({ signal, client: queries }): Promise<ChatDetails> => {
					const latest = await Effect.runPromise(
						client.api.chats.get({
							params: { chatId },
							query: { limit: DEFAULT_CHAT_HISTORY_LIMIT },
						}),
						{ signal },
					);
					const current = queries.getQueryData<ChatDetails>(queryKey);
					if (!current) {
						return latest;
					}
					const retainedOlderMessages = current.messages.length > latest.messages.length;
					return {
						...latest,
						messages: mergeChatMessages(
							current.messages,
							latest.messages.map(keepStreamedText(current)),
						),
						olderMessagesCursor: retainedOlderMessages
							? current.olderMessagesCursor
							: latest.olderMessagesCursor,
					};
				}
			: skipToken,
	});
}

/**
 * A chat and a page of its messages. Its events keep it current
 * while it is on screen, and it is fetched again whenever it comes back.
 */
export function useChat(chatId: string | undefined) {
	const queries = useQueryClient();
	const options = chatQuery(chatId);
	const query = useQuery(options);
	const older = useMutation({
		mutationFn: ({ loadedId, cursor }: { loadedId: string; cursor: string }) =>
			Effect.runPromise(
				client.api.chats.get({
					params: { chatId: loadedId },
					query: { cursor, limit: DEFAULT_CHAT_HISTORY_LIMIT },
				}),
			),
		onSuccess: (page) => {
			queries.setQueryData(options.queryKey, (current) =>
				current
					? {
							...current,
							messages: mergeChatMessages(page.messages, current.messages),
							olderMessagesCursor: page.olderMessagesCursor,
						}
					: page,
			);
		},
	});

	return {
		...query,
		isLoadingOlder: older.isPending,
		loadOlderError: older.error,
		loadOlder: async () => {
			const cursor = query.data?.olderMessagesCursor;
			if (!query.data || !cursor) return;
			await older.mutateAsync({ loadedId: query.data.chat.id, cursor });
		},
	};
}

export function useReviewToolCall(chatId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: async ({
			toolCallId,
			decision,
		}: {
			toolCallId: string;
			decision: ToolApprovalDecision["decision"];
		}) =>
			Effect.runPromise(
				client.api.approvals.decide({ params: { toolCallId }, payload: { decision } }),
			),
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["chat", chatId] }),
				refreshEveryWorkspaceApprovals(queries),
			]),
	});
}

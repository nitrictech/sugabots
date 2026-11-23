import {
	type ConversationDetails,
	DEFAULT_CONVERSATION_HISTORY_LIMIT,
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
import { refreshEveryApprovalInbox } from "@/lib/chats.ts";
import { mergeConversationMessages } from "@/lib/conversation-events.ts";

/**
 * A message fetched while it streams is behind the deltas already applied: the
 * row is flushed about once a second. Taking the fetched text would make the
 * bubble jump back, so the streamed text stays when it is the longer one.
 */
function keepStreamedText(current: ConversationDetails): (fetched: Message) => Message {
	return (fetched) => {
		const streamed = current.messages.find((message) => message.id === fetched.id);
		if (
			!streamed ||
			fetched.status !== "streaming" ||
			streamed.content.length <= fetched.content.length ||
			!streamed.content.startsWith(fetched.content)
		) {
			return fetched;
		}
		return { ...fetched, content: streamed.content, parts: streamed.parts };
	};
}

/** What a conversation's details show. Asked for only while they are open, and refreshed by the conversation's events. */
export function useConversationActivity(conversationId: string | undefined) {
	return useQuery({
		queryKey: ["conversation-activity", conversationId],
		queryFn: conversationId
			? ({ signal }) =>
					Effect.runPromise(client.api.conversations.activity({ params: { conversationId } }), {
						signal,
					})
			: skipToken,
	});
}

/**
 * A conversation and a page of its messages as it is fetched, merged into what the
 * cache already holds of it.
 */
export function conversationQuery(conversationId: string | undefined) {
	const queryKey = ["conversation", conversationId] as const;
	return queryOptions<ConversationDetails>({
		queryKey,
		// Nothing hears the conversation's events while it is off screen, and a new
		// stream starts from now, so a cached copy may have missed a reply finishing.
		refetchOnMount: "always",
		queryFn: conversationId
			? async ({ signal, client: queries }): Promise<ConversationDetails> => {
					const latest = await Effect.runPromise(
						client.api.conversations.get({
							params: { conversationId },
							query: { limit: DEFAULT_CONVERSATION_HISTORY_LIMIT },
						}),
						{ signal },
					);
					const current = queries.getQueryData<ConversationDetails>(queryKey);
					if (!current) {
						return latest;
					}
					const retainedOlderMessages = current.messages.length > latest.messages.length;
					return {
						...latest,
						messages: mergeConversationMessages(
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
 * A conversation and a page of its messages. Its events keep it current
 * while it is on screen, and it is fetched again whenever it comes back.
 */
export function useConversation(conversationId: string | undefined) {
	const queries = useQueryClient();
	const options = conversationQuery(conversationId);
	const query = useQuery(options);
	const older = useMutation({
		mutationFn: ({ loadedId, cursor }: { loadedId: string; cursor: string }) =>
			Effect.runPromise(
				client.api.conversations.get({
					params: { conversationId: loadedId },
					query: { cursor, limit: DEFAULT_CONVERSATION_HISTORY_LIMIT },
				}),
			),
		onSuccess: (page) => {
			queries.setQueryData(options.queryKey, (current) =>
				current
					? {
							...current,
							messages: mergeConversationMessages(page.messages, current.messages),
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
			await older.mutateAsync({ loadedId: query.data.conversation.id, cursor });
		},
	};
}

export function useReviewToolCall(conversationId: string) {
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
				queries.invalidateQueries({ queryKey: ["conversation", conversationId] }),
				refreshEveryApprovalInbox(queries),
			]),
	});
}

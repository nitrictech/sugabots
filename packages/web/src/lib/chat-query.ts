import {
	type ChatDetails,
	DEFAULT_CHAT_HISTORY_LIMIT,
	type Message,
	type ToolApprovalDecision,
	type ToolCallPart,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
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
 * What to show of a message fetched while the chat's events keep it current,
 * by which execution of its turn each copy is as of.
 *
 * A newer execution's copy wins, ended or written: a turn resumed elsewhere
 * writes its step again over an older one's text, and one that runs again
 * reopens a reply that had ended. Within one execution, an ended copy wins
 * over one still written. Two copies both still written by the same one are
 * merged: the fetched row is flushed about once a second, behind the deltas
 * already applied, so the streamed text stays when it is the longer one.
 */
function keepStreamedText(current: ChatDetails): (fetched: Message) => Message {
	return (fetched) => {
		const streamed = current.messages.find((message) => message.id === fetched.id);
		if (!streamed) return fetched;
		const newer = executionOf(streamed) - executionOf(fetched);
		if (newer < 0) return fetched;
		if (newer > 0) return streamed;
		if (fetched.status !== "writing") return fetched;
		if (streamed.status !== "writing") return streamed;
		const textAhead =
			streamed.content.length > fetched.content.length &&
			streamed.content.startsWith(fetched.content);
		const thinking = new Map((fetched.thinking ?? []).map((part) => [part.step, part]));
		for (const part of streamed.thinking ?? []) {
			const stored = thinking.get(part.step);
			if (!stored || part.text.startsWith(stored.text)) thinking.set(part.step, part);
		}
		return {
			...fetched,
			...(textAhead ? { content: streamed.content, parts: streamed.parts } : {}),
			...(thinking.size > 0
				? { thinking: [...thinking.values()].sort((a, b) => a.step - b.step) }
				: {}),
		};
	};
}

/** Which execution a reply is as of; one with none, as before its first step, comes before any. */
function executionOf(message: Message): number {
	return message.execution ?? -1;
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
					const fetchedIds = new Set(latest.messages.map(({ id }) => id));
					const retained = current.messages.filter(
						(message) => message.status !== "writing" || fetchedIds.has(message.id),
					);
					const retainedOlderMessages = retained.length > latest.messages.length;
					return {
						...latest,
						messages: mergeChatMessages(retained, latest.messages.map(keepStreamedText(current))),
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

export function useReviewToolCall(chatId: string | null, approvalId: string | undefined) {
	const queries = useQueryClient();
	const refresh = () =>
		Promise.all([
			...(chatId ? [queries.invalidateQueries({ queryKey: ["chat", chatId] })] : []),
			refreshEveryWorkspaceApprovals(queries),
		]);
	const review = useMutation({
		mutationKey: ["review-tool-call", approvalId],
		/**
		 * Decides the approval the member was shown on `call`: one asked again
		 * since has a new approval, which this doesn't decide.
		 */
		mutationFn: async ({
			call,
			decision,
		}: {
			call: Pick<ToolCallPart, "id" | "approval">;
			decision: ToolApprovalDecision["decision"];
		}) =>
			Effect.runPromise(
				client.api.approvals.decide({
					params: { toolCallId: call.id },
					payload: { approvalId: call.approval?.id ?? "", decision },
				}),
			),
		onSuccess: refresh,
		onError: (error) => {
			if (isApiFailure(error) && error._tag === "Conflict") void refresh();
		},
	});
	const current = review.variables?.call.approval?.id === approvalId;
	return {
		mutate: review.mutate,
		isPending: current && review.isPending,
		isSuccess: current && review.isSuccess,
		error: current ? review.error : null,
	};
}

/**
 * Interrupts the turn `turnId` in the chat: the step under way ends at once and
 * the turn ends with what it wrote. How it ends arrives on the chat's stream.
 */
export function useInterruptTurns(chatId: string) {
	return useMutation({
		mutationFn: async (turnIds: readonly string[]) =>
			Promise.all(
				turnIds.map((turnId) =>
					Effect.runPromise(client.api.chats.interruptTurn({ params: { chatId, turnId } })),
				),
			),
	});
}

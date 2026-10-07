import {
	DEFAULT_THREAD_HISTORY_LIMIT,
	type Message,
	type ThreadDetails,
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
import { NotReadyError } from "@/lib/failure.ts";
import { mergeThreadMessages } from "@/lib/thread-events.ts";

/**
 * A message fetched while it streams is behind the deltas already applied: the
 * row is flushed about once a second. Taking the fetched text would make the
 * bubble jump back, so the streamed text stays when it is the longer one.
 */
function keepStreamedText(current: ThreadDetails): (fetched: Message) => Message {
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

/** What a thread's sidebar shows. Asked for only while the sidebar is open, and refreshed by the thread's events. */
export function useThreadActivity(threadId: string | undefined) {
	return useQuery({
		queryKey: ["thread-activity", threadId],
		queryFn: threadId
			? ({ signal }) =>
					Effect.runPromise(client.api.threads.activity({ params: { threadId } }), { signal })
			: skipToken,
	});
}

/**
 * A thread and a page of its messages as it is fetched, merged into what the
 * cache already holds of it.
 */
export function threadQuery(threadId: string | undefined) {
	const queryKey = ["thread", threadId] as const;
	return queryOptions<ThreadDetails>({
		queryKey,
		// Nothing hears the thread's events while it is off screen, and a new
		// stream starts from now, so a cached copy may have missed a reply finishing.
		refetchOnMount: "always",
		queryFn: threadId
			? async ({ signal, client: queries }): Promise<ThreadDetails> => {
					const latest = await Effect.runPromise(
						client.api.threads.get({
							params: { threadId },
							query: { limit: DEFAULT_THREAD_HISTORY_LIMIT },
						}),
						{ signal },
					);
					const current = queries.getQueryData<ThreadDetails>(queryKey);
					if (!current) {
						return latest;
					}
					const retainedOlderMessages = current.messages.length > latest.messages.length;
					return {
						...latest,
						messages: mergeThreadMessages(
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
 * A thread and a page of its messages. The thread's events keep it current
 * while it is on screen, and it is fetched again whenever it comes back.
 */
export function useThread(threadId: string | undefined) {
	const queries = useQueryClient();
	const options = threadQuery(threadId);
	const query = useQuery(options);
	const older = useMutation({
		mutationFn: async (cursor: string) => {
			if (!threadId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.threads.get({
					params: { threadId },
					query: { cursor, limit: DEFAULT_THREAD_HISTORY_LIMIT },
				}),
			);
		},
		onSuccess: (page) => {
			queries.setQueryData(options.queryKey, (current) =>
				current
					? {
							...current,
							messages: mergeThreadMessages(page.messages, current.messages),
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
			if (query.data?.olderMessagesCursor) {
				await older.mutateAsync(query.data.olderMessagesCursor);
			}
		},
	};
}

export function useReviewToolCall(threadId: string, podId: string) {
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
				client.api.toolApprovals.decide({ params: { podId, toolCallId }, payload: { decision } }),
			),
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["thread", threadId] }),
				refreshEveryApprovalInbox(queries),
			]),
	});
}

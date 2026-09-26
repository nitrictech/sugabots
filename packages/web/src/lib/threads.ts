import {
	DEFAULT_THREAD_HISTORY_LIMIT,
	type Message,
	type ThreadDetails,
	type ToolApprovalDecision,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { mergeThreadMessages } from "@/lib/thread-events.ts";

const RUNNING_THREAD_REFETCH_INTERVAL_MS = 1_000;

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

export function useThread(threadId: string | undefined) {
	const queries = useQueryClient();
	const queryKey = ["thread", threadId] as const;
	const query = useQuery<ThreadDetails>({
		queryKey,
		refetchInterval: (current) =>
			current.state.data?.thread.status === "running" ? RUNNING_THREAD_REFETCH_INTERVAL_MS : false,
		queryFn: threadId
			? async ({ signal }): Promise<ThreadDetails> => {
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
			queries.setQueryData<ThreadDetails>(queryKey, (current) =>
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
		onSuccess: () => queries.invalidateQueries({ queryKey: ["thread", threadId] }),
	});
}

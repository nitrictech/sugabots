import type { Message, Thread, ThreadDetails, ToolApprovalDecision } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { mergeThreadMessages } from "@/lib/thread-events.ts";
import { useWorkspace } from "@/lib/workspace.ts";

const RUNNING_THREAD_REFETCH_INTERVAL_MS = 1_000;

export function useThreads() {
	const workspace = useWorkspace();
	const workspaceId = workspace.workspace?.id;
	const query = useQuery({
		queryKey: ["threads", workspaceId],
		queryFn: workspaceId
			? () => unwrap(client.api.workspaces[":workspaceId"].threads.$get({ param: { workspaceId } }))
			: skipToken,
	});

	return { ...query, isPending: workspace.isPending || query.isPending };
}

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
	const query = useQuery({
		queryKey,
		refetchInterval: (current) =>
			current.state.data?.thread.status === "running" ? RUNNING_THREAD_REFETCH_INTERVAL_MS : false,
		queryFn: threadId
			? async () => {
					const latest = await unwrap(
						client.api.threads[":threadId"].$get({ param: { threadId }, query: {} }),
					);
					const current = queries.getQueryData<ThreadDetails>(queryKey);
					if (!latest || !current) {
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
			const page = await unwrap(
				client.api.threads[":threadId"].$get({ param: { threadId }, query: { cursor } }),
			);
			if (!page) {
				throw new Error("Thread history returned no page");
			}
			return page;
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

export function threadsForAgent(
	threads: Thread[] | undefined,
	agentId: string,
	podId?: string,
): Thread[] {
	return (threads ?? []).filter(
		(thread) => thread.hostAgentId === agentId && (podId === undefined || thread.podId === podId),
	);
}

export function useCancelTurn(threadId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: async (turnId: string) => {
			await unwrapEmpty(client.api.turns[":turnId"].cancel.$post({ param: { turnId } }));
		},
		onSuccess: async () => {
			await queries.invalidateQueries({ queryKey: ["thread", threadId] });
		},
	});
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
			unwrap(
				client.api.pods[":podId"]["tool-calls"][":toolCallId"].approval.$post({
					param: { podId, toolCallId },
					json: { decision },
				}),
			),
		onSuccess: async () => {
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["thread", threadId] }),
				queries.invalidateQueries({ queryKey: ["tool-approval-rules", podId] }),
			]);
		},
	});
}

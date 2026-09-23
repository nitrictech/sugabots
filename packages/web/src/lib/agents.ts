import type { Agent, AgentUpdate, NewAgentInPod } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The agents in the workspace being looked at.
 *
 * One query for the whole roster, which the rail lists and every agent route
 * resolves its `:agent` id out of — the same arrangement pods have, and the
 * reason there is no by-id fetch on the way into a page.
 *
 * The API scopes it: an agent is visible through the pods you are in, and
 * an admin sees all of them because placing agents into pods is their job.
 */
export function useAgents(): {
	agents: Agent[] | undefined;
	isPending: boolean;
	error: unknown;
	refetch: () => Promise<unknown>;
} {
	const workspace = useWorkspace();
	const workspaceId = workspace.workspace?.id;

	const query = useQuery({
		queryKey: ["agents", workspaceId],
		queryFn: workspaceId
			? () => unwrap(client.api.workspaces[":workspaceId"].agents.$get({ param: { workspaceId } }))
			: skipToken,
	});

	return {
		agents: query.data,
		isPending: workspace.isPending || query.isPending,
		error: query.error,
		refetch: query.refetch,
	};
}

export function useAgent(agentId: string | undefined): {
	agent: Agent | undefined;
	isPending: boolean;
	error: unknown;
} {
	const { agents, isPending, error } = useAgents();
	return {
		agent: agentId === undefined ? undefined : agents?.find((one) => one.id === agentId),
		isPending,
		error,
	};
}

export function useModels(enabled = true) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["models", workspaceId],
		queryFn:
			workspaceId && enabled
				? () =>
						unwrap(
							client.api.workspaces[":workspaceId"]["model-providers"].models.$get({
								param: { workspaceId },
							}),
						)
				: skipToken,
	});
}

export function useCreateAgent(podId: string) {
	const invalidate = useInvalidateAgents();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: async (input: NewAgentInPod) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			const agent = await unwrap(
				client.api.pods[":podId"].agents.$post({
					param: { podId },
					json: input,
				}),
			);
			if (!agent) {
				throw new Error("Agent creation returned no agent");
			}
			return agent;
		},
		onSuccess: invalidate,
	});
}

/**
 * Saves a change to one agent. The roster is patched before the API answers,
 * so a switch moves under the pointer rather than after a round trip, and put
 * back if the save fails. The roster is refetched afterwards either way.
 */
export function useUpdateAgent(agentId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const invalidate = useInvalidateAgents();
	const rosterKey = ["agents", workspaceId];

	return useMutation({
		mutationFn: (input: AgentUpdate) =>
			unwrap(client.api.agents[":agentId"].$patch({ param: { agentId }, json: input })),
		onMutate: async (input) => {
			await queries.cancelQueries({ queryKey: rosterKey });
			const before = queries.getQueryData<Agent[]>(rosterKey);
			queries.setQueryData<Agent[]>(rosterKey, (roster) =>
				roster?.map((agent) => (agent.id === agentId ? { ...agent, ...input } : agent)),
			);
			return { before };
		},
		onError: (_error, _input, context) => {
			if (context?.before) queries.setQueryData(rosterKey, context.before);
		},
		// Not awaited: the save's outcome should not wait on the roster refetch.
		onSettled: () => {
			void invalidate();
		},
	});
}

export function useDeleteAgent() {
	const invalidate = useInvalidateAgents();

	return useMutation({
		mutationFn: (agentId: string) =>
			unwrapEmpty(client.api.agents[":agentId"].$delete({ param: { agentId } })),
		onSuccess: invalidate,
	});
}

function useInvalidateAgents(): () => Promise<void> {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return async () => {
		await queries.invalidateQueries({ queryKey: ["agents", workspaceId] });
	};
}

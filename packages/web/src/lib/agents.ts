import type { Agent, AgentUpdate, NewAgentInPod, Pod } from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The agents in the workspace being looked at.
 *
 * One query for the whole roster, which the rail lists and every agent route
 * resolves its agent handle out of — the same arrangement pods have, and the
 * reason there is no by-id fetch on the way into a page.
 *
 * The API scopes it: an agent is visible through the pods you are in, and
 * an admin sees all of them because placing agents into pods is their job.
 */
export function useAgents(): {
	agents: readonly Agent[] | undefined;
	isPending: boolean;
	error: unknown;
	refetch: () => Promise<unknown>;
} {
	const workspace = useWorkspace();
	const query = useQuery(agentsQuery(workspace.workspace?.id));

	return {
		agents: query.data,
		isPending: workspace.isPending || query.isPending,
		error: query.error,
		refetch: query.refetch,
	};
}

/** The agents query, for a route loader to fill before its page renders. */
export function agentsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["agents", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.agents.list({ params: { workspaceId } }), { signal })
			: skipToken,
	});
}

/**
 * The pod and agent an address names. A handle is unique only within its pod,
 * so the agent is looked for in that pod alone: the same handle in another pod
 * is a different agent, not a fallback.
 */
export function findPodAgent(
	pods: readonly Pod[] | undefined,
	agents: readonly Agent[] | undefined,
	podSlug: string,
	handle: string,
): { pod: Pod; agent: Agent } | undefined {
	const pod = findPod(pods, podSlug);
	const agent = pod && agents?.find((one) => one.podId === pod.id && one.handle === handle);
	return pod && agent ? { pod, agent } : undefined;
}

/**
 * The agent a workspace opens on, with its pod. Crew only, and it has to stay
 * that way: nobody talks to a built-in agent, so none may be landed on.
 */
export function firstCrewAgent(
	pods: readonly Pod[] | undefined,
	agents: readonly Agent[] | undefined,
): { pod: Pod; agent: Agent } | undefined {
	const agent = agents?.find((agent) => agent.systemAgentKey === null);
	const pod = pods?.find((pod) => pod.id === agent?.podId);
	return pod && agent ? { pod, agent } : undefined;
}

/** `findPodAgent` over the cached rosters, so a page sees renames and removals as they land. */
export function usePodAgent(podSlug: string, handle: string) {
	const { data: pods } = usePods();
	const { agents } = useAgents();
	return findPodAgent(pods, agents, podSlug, handle);
}

/** An agent and its pod, by the agent's id, or `undefined` until both rosters have them. */
export function useAgentWithPod(agentId: string): { pod: Pod; agent: Agent } | undefined {
	const { agents } = useAgents();
	const { data: pods } = usePods();
	const agent = agents?.find((agent) => agent.id === agentId);
	const pod = pods?.find((pod) => pod.id === agent?.podId);
	return agent && pod ? { pod, agent } : undefined;
}

export function useModels(enabled = true) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["models", workspaceId],
		queryFn:
			workspaceId && enabled
				? ({ signal }) =>
						Effect.runPromise(
							client.api.modelProviders.listEnabledModels({ params: { workspaceId } }),
							{ signal },
						)
				: skipToken,
	});
}

export function useCreateAgent(podId: string) {
	const invalidate = useInvalidateAgents();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: NewAgentInPod) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return Effect.runPromise(client.api.agents.create({ params: { podId }, payload: input }));
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
			Effect.runPromise(client.api.agents.update({ params: { agentId }, payload: input })),
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
			Effect.runPromise(client.api.agents.remove({ params: { agentId } })),
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

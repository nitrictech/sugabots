import type { SystemAgent, SystemAgentKey } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The Scribe and the Facilitator: the two agents the product ships, which the
 * workspace owns and every pod is served by.
 *
 * "Built in" rather than "system agent" everywhere a person reads: that is what
 * the product has called them since before they had a home of their own, and a
 * pod has nothing to do with them.
 */

/** The order they are shown in, and the only two there are. */
export const BUILT_IN_AGENT_KEYS: readonly SystemAgentKey[] = ["summarise", "facilitate"];

/** What a person is told is not happening while no model has been chosen. */
export const BUILT_IN_AGENT_UNSET: Record<SystemAgentKey, string> = {
	summarise: "No model yet, so threads have no summaries.",
	facilitate: "No model yet, so no pod can hand it the floor.",
};

/** The name to fall back on before the roster has loaded. */
export const BUILT_IN_AGENT_NAME: Record<SystemAgentKey, string> = {
	summarise: "Scribe",
	facilitate: "Facilitator",
};

export function isBuiltInAgentKey(value: string | undefined): value is SystemAgentKey {
	return value !== undefined && BUILT_IN_AGENT_KEYS.includes(value as SystemAgentKey);
}

/** Whether this one runs at all. A model is the whole of setting one up. */
export function isSetUp(agent: SystemAgent | undefined): boolean {
	return agent?.model != null;
}

/**
 * The workspace's built-in agents. Read by everyone: the summary rail and a
 * pod's routing options both have to say why one is not working.
 */
export function useBuiltInAgents() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["built-in-agents", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.systemAgents.list({ params: { workspaceId } }), { signal })
			: skipToken,
	});
}

/** One of them, by key. */
export function useBuiltInAgent(key: SystemAgentKey | undefined) {
	const { data, isPending, error } = useBuiltInAgents();
	return {
		agent: key === undefined ? undefined : data?.find((candidate) => candidate.key === key),
		isPending,
		error,
	};
}

/** Choosing the model one runs on, or `null` to turn it off. */
export function useChooseBuiltInAgentModel(key: SystemAgentKey) {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (model: string | null) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return await Effect.runPromise(
				client.api.systemAgents.update({ params: { workspaceId, key }, payload: { model } }),
			);
		},
		onSuccess: async () => {
			// A pod's routing options read the Facilitator's model to decide
			// whether they may be chosen, and turning the Facilitator off switches
			// routing off in every pod using it, so pods go stale on this save too.
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["built-in-agents", workspaceId] }),
				queryClient.invalidateQueries({ queryKey: ["pods", workspaceId] }),
			]);
		},
	});
}

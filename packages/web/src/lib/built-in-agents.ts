import type { SystemAgentKey } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The Scribe and the Facilitator: the two agents the product ships, which the
 * workspace owns and every pod is served by. People read them as the system
 * agents, which share one model chosen on the Models page.
 */

/** The order they are shown in, and the only two there are. */
export const BUILT_IN_AGENT_KEYS: readonly SystemAgentKey[] = ["summarise", "facilitate"];

/**
 * The workspace's built-in agents. Read by everyone: a chat's summary has to
 * say why there is none when the Scribe has no model.
 */
export function useBuiltInAgents() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["built-in-agents", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.systemAgents.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
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
				client.api.systemAgents.update({
					params: { workspace: workspaceId, key },
					payload: { model },
				}),
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

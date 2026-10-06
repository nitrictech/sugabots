import type { CompleteOnboarding, ProviderModel } from "@sugabots/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { agentsQuery, useUpdateAgent } from "@/lib/agents.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { workspacesQuery } from "@/lib/workspace.ts";

/** Finishing setup makes the first bot's model the workspace's default and every system agent's. */
export function useCompleteOnboarding() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (payload: CompleteOnboarding) =>
			Effect.runPromise(client.api.onboarding.complete({ payload })),
		onSuccess: (_, { workspaceId }) =>
			Promise.all([
				// The workspace is now set up, which the shell asks before it opens it.
				queries.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
				queries.invalidateQueries({ queryKey: ["models", workspaceId] }),
				queries.invalidateQueries({ queryKey: agentsQuery(workspaceId).queryKey }),
			]),
	});
}

/**
 * Listing the models of the provider onboarding just added, so the person can
 * choose one. Adding a server you run, which needs no key, lists none by
 * itself. Resolves once the workspace's providers include the list.
 */
export function useListFirstProviderModels(): (providerId: string) => Promise<void> {
	const { fetchModels } = useProviderActions();
	// A list that cannot be fetched yet leaves the starter models, which is enough to begin.
	return (providerId) =>
		fetchModels.mutateAsync({ providerId }).then(
			() => undefined,
			() => undefined,
		);
}

/**
 * The second half of onboarding's model step: switching `model` on for the
 * workspace and running the first bot, `agentId`, on it. Without a bot, which
 * only a missing Personal pod leaves, the model is still switched on.
 */
export function useChooseFirstModel(agentId: string | undefined) {
	const actions = useProviderActions();
	const updateAgent = useUpdateAgent(agentId ?? "");
	return useMutation({
		mutationFn: async ({ providerId, model }: { providerId: string; model: ProviderModel }) => {
			if (!model.enabled) {
				await actions.setModel.mutateAsync({ providerId, modelId: model.id, enabled: true });
			}
			if (agentId) await updateAgent.mutateAsync({ model: model.modelId });
		},
	});
}

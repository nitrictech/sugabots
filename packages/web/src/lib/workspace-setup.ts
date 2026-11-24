import type { CompleteWorkspaceSetup, ProviderModel } from "@sugabots/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { botsQuery, useEnsureAssistant } from "@/lib/bots.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { workspacesQuery } from "@/lib/workspace.ts";

/** Finishing setup makes the first bot's model the workspace's default and every system bot's. */
export function useCompleteWorkspaceSetup() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (payload: CompleteWorkspaceSetup) =>
			Effect.runPromise(client.api.workspaceSetup.complete({ payload })),
		onSuccess: (_, { workspaceId }) =>
			Promise.all([
				// The workspace is now set up, which the shell asks before it opens it.
				queries.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
				queries.invalidateQueries({ queryKey: ["models", workspaceId] }),
				queries.invalidateQueries({ queryKey: botsQuery(workspaceId).queryKey }),
			]),
	});
}

/**
 * Listing the models of the provider workspace setup just added, so the member can
 * choose one. Adding a server you run, which needs no key, lists none by
 * itself. Resolves once the workspace's providers include the list.
 */
export function useListFirstProviderModels(): (providerId: string) => Promise<void> {
	const { discoverModels } = useProviderActions();
	// A list that cannot be fetched yet leaves the starter models, which is enough to begin.
	return (providerId) =>
		discoverModels.mutateAsync({ providerId }).then(
			() => undefined,
			() => undefined,
		);
}

/**
 * The second half of workspace setup's model step: switching `model` on for the
 * workspace and running the member's Personal Assistant on it, made now if
 * it is missing. Sugabots manages the assistant, so it moves onto `model`
 * only while it has no model the workspace offers.
 */
export function useChooseFirstModel() {
	const actions = useProviderActions();
	const ensureAssistant = useEnsureAssistant();
	return useMutation({
		mutationFn: async ({ providerId, model }: { providerId: string; model: ProviderModel }) => {
			if (!model.enabled) {
				await actions.setModel.mutateAsync({ providerId, modelId: model.id, enabled: true });
			}
			await ensureAssistant.mutateAsync(model.modelId);
		},
	});
}

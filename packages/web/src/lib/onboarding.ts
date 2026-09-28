import type {
	CompleteOnboarding,
	ModelProvider,
	ProviderModel,
	ProviderPreset,
} from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { useUpdateAgent } from "@/lib/agents.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { useWorkspace } from "@/lib/workspace.ts";

export function useOnboarding() {
	return useQuery({
		queryKey: ["onboarding"],
		queryFn: ({ signal }) => Effect.runPromise(client.api.onboarding.status(), { signal }),
	});
}

export function useCompleteOnboarding() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (payload: CompleteOnboarding) =>
			Effect.runPromise(client.api.onboarding.complete({ payload })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["onboarding"] }),
	});
}

/**
 * Connecting the first provider, the first half of onboarding's model step:
 * its key (or, for a server you run, its address) and its model list.
 * Resolves to the provider as it stands afterwards, models and all, so the
 * person can choose one. It switches none of them on; choosing does that.
 *
 * Anthropic, OpenAI and Ollama exist in every workspace from the start, so
 * connecting one of them updates it rather than adding another.
 */
export function useConnectFirstProvider() {
	const actions = useProviderActions();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: async ({
			preset,
			existing,
			apiKey,
			baseUrl,
		}: {
			preset: ProviderPreset;
			existing?: ModelProvider;
			apiKey?: string;
			baseUrl?: string;
		}): Promise<ModelProvider> => {
			if (!workspaceId) throw new NotReadyError();
			const connected = existing
				? await actions.update.mutateAsync({
						providerId: existing.id,
						json: {
							active: true,
							...(apiKey ? { apiKey } : {}),
							...(baseUrl && baseUrl !== existing.baseUrl ? { baseUrl } : {}),
						},
					})
				: await actions.create.mutateAsync({
						preset: preset.id,
						apiKey,
						...(baseUrl && baseUrl !== preset.baseUrl ? { baseUrl } : {}),
					});
			// A list that cannot be fetched yet leaves the starter models, which is enough to begin.
			await actions.fetchModels.mutateAsync({ providerId: connected.id }).catch(() => undefined);
			return Effect.runPromise(
				client.api.modelProviders.get({
					params: { workspace: workspaceId, providerId: connected.id },
				}),
			);
		},
	});
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

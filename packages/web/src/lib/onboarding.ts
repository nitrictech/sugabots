import type { CompleteOnboarding, ModelProvider, ProviderPreset } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
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
 * Connecting the first provider, as onboarding's one step: its key (or, for a
 * server you run, its address), its model list, and a few of its models
 * switched on so the first bot has one to run on. Resolves to the model the
 * first bot should use, or `undefined` if the provider offered none.
 *
 * Anthropic, OpenAI and Ollama exist in every workspace from the start, so
 * connecting one of them updates it rather than adding another.
 */
export function useConnectFirstModel() {
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
		}): Promise<string | undefined> => {
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
			const fresh = await Effect.runPromise(
				client.api.modelProviders.get({
					params: { workspace: workspaceId, providerId: connected.id },
				}),
			);
			const alreadyOn = fresh.models.filter((model) => model.enabled);
			if (alreadyOn.length > 0) return alreadyOn[0]?.modelId;
			const starters = preset.models.map((model) => model.modelId);
			const toSwitchOn = starters.length
				? fresh.models.filter((model) => starters.includes(model.modelId))
				: fresh.models.slice(0, 1);
			if (toSwitchOn.length === 0) return undefined;
			await actions.setModels.mutateAsync({
				providerId: connected.id,
				modelIds: toSwitchOn.map((model) => model.id),
				enabled: true,
			});
			// In the catalog's order, which lists each provider's flagship first.
			return (
				starters.find((modelId) => toSwitchOn.some((model) => model.modelId === modelId)) ??
				toSwitchOn[0]?.modelId
			);
		},
	});
}

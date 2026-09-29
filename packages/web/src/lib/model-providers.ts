import type {
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModelUpdate,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

export function useModelProviders() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["model-providers", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.modelProviders.list({ params: { workspace: workspaceId } }),
						{
							signal,
						},
					)
			: skipToken,
	});
}

export function useProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	// The first model a workspace switches on becomes its default and every
	// built-in agent's, so any of these changes can move those too.
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] }),
			queryClient.invalidateQueries({ queryKey: ["models", workspaceId] }),
			queryClient.invalidateQueries({ queryKey: ["built-in-agents", workspaceId] }),
		]);
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}

	return {
		create: useMutation({
			mutationFn: (json: NewModelProvider) => {
				const workspaceId = requiredWorkspace();
				const { create } = client.api.modelProviders;
				return Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					create({ params: { workspace: workspaceId }, payload: json } as Parameters<
						typeof create
					>[0]),
				);
			},
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ providerId, json }: { providerId: string; json: ModelProviderUpdate }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.update({
						params: { workspace: workspaceId, providerId },
						payload: json,
					}),
				);
			},
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.remove({ params: { workspace: workspaceId, providerId } }),
				);
			},
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.test({ params: { workspace: workspaceId, providerId } }),
				);
			},
			onSuccess: refresh,
		}),
		startChatgptSignIn: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.startChatgptSignIn({
						params: { workspace: workspaceId, providerId },
					}),
				);
			},
		}),
		completeChatgptSignIn: useMutation({
			mutationFn: ({ providerId, attempt }: { providerId: string; attempt: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.completeChatgptSignIn({
						params: { workspace: workspaceId, providerId },
						payload: { attempt },
					}),
				);
			},
			onSuccess: (outcome) => (outcome.status === "signed_in" ? refresh() : undefined),
		}),
		signOutChatgpt: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.signOutChatgpt({
						params: { workspace: workspaceId, providerId },
					}),
				);
			},
			onSuccess: refresh,
		}),
		fetchModels: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.fetchModels({ params: { workspace: workspaceId, providerId } }),
				);
			},
			onSettled: refresh,
		}),
		addModel: useMutation({
			mutationFn: ({ providerId, modelId }: { providerId: string; modelId: string }) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.addModel({
						params: { workspace: workspaceId, providerId },
						payload: { modelId, capabilities: [] },
					}),
				);
			},
			onSuccess: refresh,
		}),
		setModel: useMutation({
			mutationFn: ({
				providerId,
				modelId,
				enabled,
			}: {
				providerId: string;
				modelId: string;
				enabled: boolean;
			}) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.updateModel({
						params: { workspace: workspaceId, providerId, modelId },
						payload: { enabled },
					}),
				);
			},
			onSuccess: refresh,
		}),
		updateModel: useMutation({
			mutationFn: ({
				providerId,
				modelId,
				json,
			}: {
				providerId: string;
				modelId: string;
				json: ProviderModelUpdate;
			}) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.updateModel({
						params: { workspace: workspaceId, providerId, modelId },
						payload: json,
					}),
				);
			},
			onSuccess: refresh,
		}),
		setModels: useMutation({
			mutationFn: ({
				providerId,
				modelIds,
				enabled,
			}: {
				providerId: string;
				modelIds: string[];
				enabled: boolean;
			}) => {
				const workspaceId = requiredWorkspace();
				return Effect.runPromise(
					client.api.modelProviders.setModelsEnabled({
						params: { workspace: workspaceId, providerId },
						payload: { modelIds, enabled },
					}),
				);
			},
			onSuccess: refresh,
		}),
	};
}

/** Choosing the model the workspace's new bots start on. */
export function useChooseDefaultModel() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) => {
			if (!workspaceId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.modelProviders.setDefaultModel({
					params: { workspace: workspaceId },
					payload: { model },
				}),
			);
		},
		onSuccess: (models) => queryClient.setQueryData(["models", workspaceId], models),
	});
}

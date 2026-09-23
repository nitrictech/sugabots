import type {
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModelUpdate,
} from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

export function useModelProviders() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["model-providers", workspaceId],
		queryFn: workspaceId
			? () =>
					unwrap(
						client.api.workspaces[":workspaceId"]["model-providers"].$get({
							param: { workspaceId },
						}),
					)
			: skipToken,
	});
}

export function useProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] }),
			queryClient.invalidateQueries({ queryKey: ["models", workspaceId] }),
		]);
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}

	return {
		create: useMutation({
			mutationFn: (json: NewModelProvider) => {
				const workspaceId = requiredWorkspace();
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"].$post({
						param: { workspaceId },
						json,
					}),
				);
			},
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ providerId, json }: { providerId: string; json: ModelProviderUpdate }) => {
				const workspaceId = requiredWorkspace();
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].$patch({
						param: { workspaceId, providerId },
						json,
					}),
				);
			},
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return unwrapEmpty(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].$delete({
						param: { workspaceId, providerId },
					}),
				);
			},
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].test.$post({
						param: { workspaceId, providerId },
					}),
				);
			},
			onSuccess: refresh,
		}),
		fetchModels: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspace();
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"][
						"fetch-models"
					].$post({ param: { workspaceId, providerId } }),
				);
			},
			onSettled: refresh,
		}),
		addModel: useMutation({
			mutationFn: ({ providerId, modelId }: { providerId: string; modelId: string }) => {
				const workspaceId = requiredWorkspace();
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].models.$post({
						param: { workspaceId, providerId },
						json: { modelId, capabilities: [] },
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
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].models[
						":modelId"
					].$patch({ param: { workspaceId, providerId, modelId }, json: { enabled } }),
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
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].models[
						":modelId"
					].$patch({ param: { workspaceId, providerId, modelId }, json }),
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
				return unwrap(
					client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].models.$patch({
						param: { workspaceId, providerId },
						json: { modelIds, enabled },
					}),
				);
			},
			onSuccess: refresh,
		}),
	};
}

import type {
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelSwitchOff,
	ProviderModelUpdate,
	ProviderSwitchOff,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { botsQuery } from "@/lib/bots.ts";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

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
	// The first model a workspace switches on becomes its default, every system bot's and every
	// model-less Personal Assistant's, and switching a model off moves the bots on it, so any of
	// these changes can move the bots too.
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["model-providers", workspaceId] }),
			queryClient.invalidateQueries({ queryKey: ["models", workspaceId] }),
			queryClient.invalidateQueries({ queryKey: ["system-bots", workspaceId] }),
			queryClient.invalidateQueries({ queryKey: botsQuery(workspaceId).queryKey }),
		]);
	const requiredWorkspaceId = useRequiredWorkspaceId();

	return {
		create: useMutation({
			mutationFn: (json: NewModelProvider) => {
				const workspaceId = requiredWorkspaceId();
				const { create } = client.api.modelProviders;
				return Effect.runPromise(
					create({ params: { workspace: workspaceId }, payload: { provider: json } }),
				);
			},
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ providerId, json }: { providerId: string; json: ModelProviderUpdate }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.update({
						params: { workspace: workspaceId, providerId },
						payload: { changes: json },
					}),
				);
			},
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.remove({ params: { workspace: workspaceId, providerId } }),
				);
			},
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.test({ params: { workspace: workspaceId, providerId } }),
				);
			},
			onSuccess: refresh,
		}),
		startSignIn: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.startSignIn({
						params: { workspace: workspaceId, providerId },
					}),
				);
			},
		}),
		completeSignIn: useMutation({
			mutationFn: ({ providerId, attempt }: { providerId: string; attempt: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.completeSignIn({
						params: { workspace: workspaceId, providerId },
						payload: { attempt },
					}),
				);
			},
			onSuccess: (outcome) => (outcome.status === "signed_in" ? refresh() : undefined),
		}),
		signOut: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.signOut({
						params: { workspace: workspaceId, providerId },
					}),
				);
			},
			onSuccess: refresh,
		}),
		discoverModels: useMutation({
			mutationFn: ({ providerId }: { providerId: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.discoverModels({
						params: { workspace: workspaceId, providerId },
					}),
				);
			},
			onSettled: refresh,
		}),
		addModel: useMutation({
			mutationFn: ({ providerId, modelId }: { providerId: string; modelId: string }) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.addModel({
						params: { workspace: workspaceId, providerId },
						payload: { model: { modelId, capabilities: [] } },
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
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.updateModel({
						params: { workspace: workspaceId, providerId, modelId },
						payload: { changes: { enabled } },
					}),
				);
			},
			onSuccess: refresh,
		}),
		switchOffModel: useMutation({
			mutationFn: ({
				providerId,
				modelId,
				...payload
			}: { providerId: string; modelId: string } & ProviderModelSwitchOff) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.switchOffModel({
						params: { workspace: workspaceId, providerId, modelId },
						payload,
					}),
				);
			},
			onSuccess: refresh,
		}),
		switchOff: useMutation({
			mutationFn: ({ providerId, ...payload }: { providerId: string } & ProviderSwitchOff) => {
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.switchOff({
						params: { workspace: workspaceId, providerId },
						payload,
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
				const workspaceId = requiredWorkspaceId();
				return Effect.runPromise(
					client.api.modelProviders.updateModel({
						params: { workspace: workspaceId, providerId, modelId },
						payload: { changes: json },
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
	const requiredWorkspaceId = useRequiredWorkspaceId();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) =>
			Effect.runPromise(
				client.api.modelProviders.setDefaultModel({
					params: { workspace: requiredWorkspaceId() },
					payload: { model },
				}),
			),
		onSuccess: (models) => queryClient.setQueryData(["models", workspaceId], models),
	});
}

/** What a model is called: its display name, or its id where the provider gives none. */
export function modelName(model: Pick<ProviderModel, "displayName" | "modelId">): string {
	return model.displayName ?? model.modelId;
}

import type {
	NewSandboxProvider,
	SandboxNetworkSettings,
	SandboxProviderUpdate,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The sandbox providers the workspace has configured, oldest first. */
export function useSandboxProviders() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["sandbox-providers", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.sandboxProviders.list({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/**
 * Whether the workspace's agents can be given a sandbox. Any member may read
 * it. Its key starts with the providers' key, so changing a provider refetches it.
 */
export function useSandboxAccess() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["sandbox-providers", workspaceId, "access"],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.sandboxProviders.access({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

export function useSandboxProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["sandbox-providers", workspaceId] });
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}

	return {
		create: useMutation({
			mutationFn: (json: NewSandboxProvider) =>
				Effect.runPromise(
					client.api.sandboxProviders.create({
						params: { workspace: requiredWorkspace() },
						payload: json,
					}),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({
				providerId,
				changes,
			}: {
				providerId: string;
				changes: SandboxProviderUpdate;
			}) =>
				Effect.runPromise(
					client.api.sandboxProviders.update({
						params: { workspace: requiredWorkspace(), providerId },
						payload: changes,
					}),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (providerId: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.remove({
						params: { workspace: requiredWorkspace(), providerId },
					}),
				),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: (providerId: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.test({
						params: { workspace: requiredWorkspace(), providerId },
					}),
				),
			onSettled: refresh,
		}),
	};
}

/**
 * How an E2B provider's template stands. Checked again every few seconds
 * while it is building, which takes minutes.
 */
export function useSandboxTemplate(providerId: string | undefined) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["sandbox-providers", workspaceId, providerId, "template"],
		queryFn:
			workspaceId && providerId
				? ({ signal }) =>
						Effect.runPromise(
							client.api.sandboxProviders.template({
								params: { workspace: workspaceId, providerId },
							}),
							{ signal },
						)
				: skipToken,
		refetchInterval: (query) => (query.state.data?.state === "building" ? 5_000 : false),
	});
}

export function usePrepareSandboxTemplate(providerId: string) {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.sandboxProviders.prepareTemplate({
					params: { workspace: workspaceId, providerId },
				}),
			);
		},
		onSuccess: (data) =>
			queryClient.setQueryData(["sandbox-providers", workspaceId, providerId, "template"], data),
	});
}

/** What the workspace lets every pod's sandbox connect to and keeps them all from, and changing either. */
export function useSandboxNetwork() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const queryKey = ["sandbox-network", workspaceId];
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}
	const settings = useQuery({
		queryKey,
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.sandboxProviders.network({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
	const store = (next: SandboxNetworkSettings) => queryClient.setQueryData(queryKey, next);
	return {
		settings,
		addHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.addHost({
						params: { workspace: requiredWorkspace() },
						payload: { host },
					}),
				),
			onSuccess: store,
		}),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.removeHost({
						params: { workspace: requiredWorkspace(), host },
					}),
				),
			onSuccess: store,
		}),
		blockHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.blockHost({
						params: { workspace: requiredWorkspace() },
						payload: { host },
					}),
				),
			onSuccess: store,
		}),
		unblockHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.sandboxProviders.unblockHost({
						params: { workspace: requiredWorkspace(), host },
					}),
				),
			onSuccess: store,
		}),
	};
}

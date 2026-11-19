import type {
	ComputerNetworkSettings,
	ComputerProviderUpdate,
	NewComputerProvider,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

/** The computer providers the workspace has configured, oldest first. */
export function useComputerProviders() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["computer-providers", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.computerProviders.list({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/** How full the disks of the workspace's computers are, of those measured. */
export function useComputerDisks() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["computer-disks", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.computerProviders.disks({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
		// They're measured every few minutes while the computers run.
		refetchInterval: 60_000,
	});
}

/**
 * Whether the workspace's bots can be given a computer. Any member may read
 * it. Its key starts with the providers' key, so changing a provider refetches it.
 */
export function useComputerAccess() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["computer-providers", workspaceId, "access"],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.computerProviders.access({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/**
 * What stands between the owner and a computer: the workspace has none set
 * up, or the owner is a bot that doesn't use one. A project always has one
 * once the workspace does. Null when nothing does, undefined until known.
 */
export function useComputerGap(owner: ResourceOwner): "workspace" | "bot" | null | undefined {
	const computers = useComputerAccess().data;
	if (computers === undefined) return undefined;
	if (!computers.enabled) return "workspace";
	if ("bot" in owner && !owner.bot.usesComputer) return "bot";
	return null;
}

export function useComputerProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const requiredWorkspace = useRequiredWorkspaceId();
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["computer-providers", workspaceId] });

	return {
		create: useMutation({
			mutationFn: (json: NewComputerProvider) =>
				Effect.runPromise(
					client.api.computerProviders.create({
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
				changes: ComputerProviderUpdate;
			}) =>
				Effect.runPromise(
					client.api.computerProviders.update({
						params: { workspace: requiredWorkspace(), providerId },
						payload: changes,
					}),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (providerId: string) =>
				Effect.runPromise(
					client.api.computerProviders.remove({
						params: { workspace: requiredWorkspace(), providerId },
					}),
				),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: (providerId: string) =>
				Effect.runPromise(
					client.api.computerProviders.test({
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
export function useComputerTemplate(providerId: string | undefined) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["computer-providers", workspaceId, providerId, "template"],
		queryFn:
			workspaceId && providerId
				? ({ signal }) =>
						Effect.runPromise(
							client.api.computerProviders.template({
								params: { workspace: workspaceId, providerId },
							}),
							{ signal },
						)
				: skipToken,
		refetchInterval: (query) => (query.state.data?.state === "building" ? 5_000 : false),
	});
}

export function usePrepareComputerTemplate(providerId: string) {
	const workspaceId = useWorkspace().workspace?.id;
	const requiredWorkspace = useRequiredWorkspaceId();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(
				client.api.computerProviders.prepareTemplate({
					params: { workspace: requiredWorkspace(), providerId },
				}),
			),
		onSuccess: (data) =>
			queryClient.setQueryData(["computer-providers", workspaceId, providerId, "template"], data),
	});
}

/**
 * What the workspace lets every computer connect to and keeps them all
 * from, and changing either. Its key starts with the providers' key, so
 * changing a provider, which sets the network mode, refetches it.
 */
export function useComputerNetwork() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const queryKey = ["computer-providers", workspaceId, "network"];
	const requiredWorkspace = useRequiredWorkspaceId();
	const settings = useQuery({
		queryKey,
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.computerProviders.network({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
	const store = (next: ComputerNetworkSettings) => queryClient.setQueryData(queryKey, next);
	return {
		settings,
		addHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.computerProviders.addHost({
						params: { workspace: requiredWorkspace() },
						payload: { host },
					}),
				),
			onSuccess: store,
		}),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.computerProviders.removeHost({
						params: { workspace: requiredWorkspace(), host },
					}),
				),
			onSuccess: store,
		}),
		blockHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.computerProviders.blockHost({
						params: { workspace: requiredWorkspace() },
						payload: { host },
					}),
				),
			onSuccess: store,
		}),
		unblockHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.computerProviders.unblockHost({
						params: { workspace: requiredWorkspace(), host },
					}),
				),
			onSuccess: store,
		}),
	};
}

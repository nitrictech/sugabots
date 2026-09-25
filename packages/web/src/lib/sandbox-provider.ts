import type { NewSandboxProvider, SandboxProviderUpdate } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The workspace's sandbox provider, or null when it has none, and what the installation allows. */
export function useSandboxProvider() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["sandbox-provider", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.sandboxProviders.get({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/** Whether a pod's sandbox is up and in use. Kept current by `sandbox.updated` events. */
export function usePodSandbox(podId: string) {
	return useQuery({
		queryKey: ["pod-sandbox", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.sandboxProviders.podStatus({ params: { podId } }), { signal }),
		// A lease that expires because its process died sends no event.
		refetchInterval: 60_000,
	});
}

export function useSandboxProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["sandbox-provider", workspaceId] });
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}

	return {
		replace: useMutation({
			mutationFn: (json: NewSandboxProvider) =>
				Effect.runPromise(
					client.api.sandboxProviders.replace({
						params: { workspace: requiredWorkspace() },
						payload: json,
					}),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: (json: SandboxProviderUpdate) =>
				Effect.runPromise(
					client.api.sandboxProviders.update({
						params: { workspace: requiredWorkspace() },
						payload: json,
					}),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: () =>
				Effect.runPromise(
					client.api.sandboxProviders.remove({ params: { workspace: requiredWorkspace() } }),
				),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: () =>
				Effect.runPromise(
					client.api.sandboxProviders.test({ params: { workspace: requiredWorkspace() } }),
				),
			onSettled: refresh,
		}),
	};
}

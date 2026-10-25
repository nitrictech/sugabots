import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** How the pod's sandbox stands, and whether the person may reset or upgrade it. */
export function usePodSandbox(podId: string | undefined) {
	return useQuery({
		queryKey: ["pod-sandbox", podId],
		queryFn: podId
			? ({ signal }) =>
					Effect.runPromise(client.api.podSandbox.get({ params: { podId } }), { signal })
			: skipToken,
		// Turns and viewers come and go; the panel keeps up without a page reload.
		refetchInterval: 15_000,
	});
}

export function usePodSandboxActions(podId: string) {
	const queryClient = useQueryClient();
	const settle = {
		onSuccess: (data: unknown) => queryClient.setQueryData(["pod-sandbox", podId], data),
	};
	return {
		reset: useMutation({
			mutationFn: () => Effect.runPromise(client.api.podSandbox.reset({ params: { podId } })),
			...settle,
		}),
		upgrade: useMutation({
			mutationFn: () => Effect.runPromise(client.api.podSandbox.upgrade({ params: { podId } })),
			...settle,
		}),
	};
}

/** What the pod's sandbox may connect to beyond what the workspace allows, and changing it. */
export function usePodSandboxNetwork(podId: string) {
	const queryClient = useQueryClient();
	const queryKey = networkQueryKey(podId);
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	return {
		network: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.podSandbox.network({ params: { podId } }), { signal }),
		}),
		addHosts: useAddPodSandboxHosts(podId),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.podSandbox.removeHost({ params: { podId, host } })),
			...store,
		}),
	};
}

/**
 * Lets the pod's sandbox reach `hosts`, all of them or none if any is
 * refused, without loading the pod's network settings first.
 */
export function useAddPodSandboxHosts(podId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (hosts: readonly string[]) =>
			Effect.runPromise(
				client.api.podSandbox.addHosts({ params: { podId }, payload: { hosts: [...hosts] } }),
			),
		onSuccess: (data: unknown) => queryClient.setQueryData(networkQueryKey(podId), data),
	});
}

function networkQueryKey(podId: string) {
	return ["pod-sandbox-network", podId];
}

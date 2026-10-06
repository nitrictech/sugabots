import type { SandboxSoftwareChannel } from "@sugabots/contracts";
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
	const queryKey = ["pod-sandbox-network", podId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	return {
		network: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.podSandbox.network({ params: { podId } }), { signal }),
		}),
		addHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.podSandbox.addHost({ params: { podId }, payload: { host } })),
			...store,
		}),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.podSandbox.removeHost({ params: { podId, host } })),
			...store,
		}),
	};
}

/** The software the pod's sandbox has beyond its image, and removing a package. */
export function usePodSandboxSoftware(podId: string) {
	const queryClient = useQueryClient();
	const queryKey = ["pod-sandbox-software", podId];
	return {
		software: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.podSandbox.software({ params: { podId } }), { signal }),
		}),
		removePackage: useMutation({
			mutationFn: (software: { name: string; channel: SandboxSoftwareChannel }) =>
				Effect.runPromise(client.api.podSandbox.removePackage({ params: { podId, ...software } })),
			onSuccess: (data) => queryClient.setQueryData(queryKey, data),
		}),
	};
}

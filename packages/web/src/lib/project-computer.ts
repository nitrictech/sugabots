import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/**
 * How the project's computer stands, and whether the person may reset or
 * upgrade it. A bot's computer is its default project's.
 */
export function useProjectComputer(projectId: string | undefined) {
	return useQuery({
		queryKey: ["project-computer", projectId],
		queryFn: projectId
			? ({ signal }) =>
					Effect.runPromise(client.api.projectComputer.get({ params: { projectId } }), { signal })
			: skipToken,
		// Turns and viewers come and go; the panel keeps up without a page reload.
		refetchInterval: 15_000,
	});
}

export function useProjectComputerActions(projectId: string) {
	const queryClient = useQueryClient();
	const settle = {
		onSuccess: (data: unknown) => queryClient.setQueryData(["project-computer", projectId], data),
	};
	return {
		reset: useMutation({
			mutationFn: () =>
				Effect.runPromise(client.api.projectComputer.reset({ params: { projectId } })),
			...settle,
		}),
		upgrade: useMutation({
			mutationFn: () =>
				Effect.runPromise(client.api.projectComputer.upgrade({ params: { projectId } })),
			...settle,
		}),
	};
}

/** What the project's computer may connect to beyond what the workspace allows, and changing it. */
export function useProjectComputerNetwork(projectId: string) {
	const queryClient = useQueryClient();
	const queryKey = ["project-computer-network", projectId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	return {
		network: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.projectComputer.network({ params: { projectId } }), {
					signal,
				}),
		}),
		addHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.projectComputer.addHost({ params: { projectId }, payload: { host } }),
				),
			...store,
		}),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.projectComputer.removeHost({ params: { projectId, host } })),
			...store,
		}),
	};
}

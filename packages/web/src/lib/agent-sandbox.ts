import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** How the bot's computer stands, and whether the person may reset or upgrade it. */
export function useAgentSandbox(agentId: string | undefined) {
	return useQuery({
		queryKey: ["agent-sandbox", agentId],
		queryFn: agentId
			? ({ signal }) =>
					Effect.runPromise(client.api.agentSandbox.get({ params: { agentId } }), { signal })
			: skipToken,
		// Turns and viewers come and go; the panel keeps up without a page reload.
		refetchInterval: 15_000,
	});
}

export function useAgentSandboxActions(agentId: string) {
	const queryClient = useQueryClient();
	const settle = {
		onSuccess: (data: unknown) => queryClient.setQueryData(["agent-sandbox", agentId], data),
	};
	return {
		reset: useMutation({
			mutationFn: () => Effect.runPromise(client.api.agentSandbox.reset({ params: { agentId } })),
			...settle,
		}),
		upgrade: useMutation({
			mutationFn: () => Effect.runPromise(client.api.agentSandbox.upgrade({ params: { agentId } })),
			...settle,
		}),
	};
}

/** What the bot's computer may connect to beyond what the workspace allows, and changing it. */
export function useAgentSandboxNetwork(agentId: string) {
	const queryClient = useQueryClient();
	const queryKey = ["agent-sandbox-network", agentId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	return {
		network: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.agentSandbox.network({ params: { agentId } }), { signal }),
		}),
		addHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(
					client.api.agentSandbox.addHost({ params: { agentId }, payload: { host } }),
				),
			...store,
		}),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.agentSandbox.removeHost({ params: { agentId, host } })),
			...store,
		}),
	};
}

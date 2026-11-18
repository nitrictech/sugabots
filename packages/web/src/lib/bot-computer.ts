import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** How the bot's computer stands, and whether the person may reset or upgrade it. */
export function useBotComputer(botId: string | undefined) {
	return useQuery({
		queryKey: ["bot-computer", botId],
		queryFn: botId
			? ({ signal }) =>
					Effect.runPromise(client.api.botComputer.get({ params: { botId } }), { signal })
			: skipToken,
		// Turns and viewers come and go; the panel keeps up without a page reload.
		refetchInterval: 15_000,
	});
}

export function useBotComputerActions(botId: string) {
	const queryClient = useQueryClient();
	const settle = {
		onSuccess: (data: unknown) => queryClient.setQueryData(["bot-computer", botId], data),
	};
	return {
		reset: useMutation({
			mutationFn: () => Effect.runPromise(client.api.botComputer.reset({ params: { botId } })),
			...settle,
		}),
		upgrade: useMutation({
			mutationFn: () => Effect.runPromise(client.api.botComputer.upgrade({ params: { botId } })),
			...settle,
		}),
	};
}

/** What the bot's computer may connect to beyond what the workspace allows, and changing it. */
export function useBotComputerNetwork(botId: string) {
	const queryClient = useQueryClient();
	const queryKey = ["bot-computer-network", botId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	return {
		network: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.botComputer.network({ params: { botId } }), { signal }),
		}),
		addHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.botComputer.addHost({ params: { botId }, payload: { host } })),
			...store,
		}),
		removeHost: useMutation({
			mutationFn: (host: string) =>
				Effect.runPromise(client.api.botComputer.removeHost({ params: { botId, host } })),
			...store,
		}),
	};
}

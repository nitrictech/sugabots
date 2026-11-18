import type { SystemBotKey } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The Summariser and Compaction: the bots the product ships, which the
 * workspace owns and every channel is served by. People read them as the system
 * bots, which share one model chosen on the Models page.
 */

/** The order they are shown in, and the only ones there are. */
export const BUILT_IN_BOT_KEYS: readonly SystemBotKey[] = ["summarise", "compact"];

/**
 * The workspace's built-in bots. Read by everyone: a chat's summary has to
 * say why there is none when the Summariser has no model.
 */
export function useBuiltInBots() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["built-in-bots", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.systemBots.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/** Choosing the model one runs on. */
export function useChooseBuiltInBotModel(key: SystemBotKey) {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (model: string) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return await Effect.runPromise(
				client.api.systemBots.update({
					params: { workspace: workspaceId, key },
					payload: { model },
				}),
			);
		},
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["built-in-bots", workspaceId] }),
	});
}

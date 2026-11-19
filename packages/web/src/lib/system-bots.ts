import type { SystemBotKey } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

/**
 * The system bots, the Summariser and Compaction: the workspace's own bots that
 * serve every project, sharing one model chosen on the Models page.
 */

/** The order they are shown in, and the only ones there are. */
export const SYSTEM_BOT_KEYS: readonly SystemBotKey[] = ["summarise", "compact"];

/**
 * The workspace's system bots. Read by everyone: a thread's summary has to
 * say why there is none when the Summariser has no model.
 */
export function useSystemBots() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["system-bots", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.systemBots.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/** Choosing the model one runs on. */
export function useChooseSystemBotModel(key: SystemBotKey) {
	const workspaceId = useWorkspace().workspace?.id;
	const requiredWorkspaceId = useRequiredWorkspaceId();
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) =>
			Effect.runPromise(
				client.api.systemBots.update({
					params: { workspace: requiredWorkspaceId(), key },
					payload: { model },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["system-bots", workspaceId] }),
	});
}

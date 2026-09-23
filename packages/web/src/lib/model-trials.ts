import type { SystemAgentKey } from "@sugabots/contracts";
import { unwrap } from "@sugabots/sdk";
import { useMutation } from "@tanstack/react-query";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * Trying a model on a system agent.
 *
 * A mutation rather than a query: it is a run of real model calls that takes
 * as long as the model does, and it happens because somebody asked for it. A
 * query would re-run it on a refocus and quietly spend the workspace's tokens.
 */
export function useModelTrial() {
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: async (input: { systemAgentKey: SystemAgentKey; model: string }) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return unwrap(
				client.api.workspaces[":workspaceId"]["model-trials"].$post({
					param: { workspaceId },
					json: input,
				}),
			);
		},
	});
}

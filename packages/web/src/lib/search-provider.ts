import type { NewSearchProvider, SearchProviderUpdate } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The workspace's search provider, or null when it has none. */
export function useSearchProvider() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["search-provider", workspaceId],
		queryFn: workspaceId
			? async () =>
					(
						await unwrap(
							client.api.workspaces[":workspaceId"]["search-provider"].$get({
								param: { workspaceId },
							}),
						)
					).provider
			: skipToken,
	});
}

export function useSearchProviderActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["search-provider", workspaceId] });
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}
	const route = () => client.api.workspaces[":workspaceId"]["search-provider"];

	return {
		replace: useMutation({
			mutationFn: (json: NewSearchProvider) =>
				unwrap(route().$put({ param: { workspaceId: requiredWorkspace() }, json })),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: (json: SearchProviderUpdate) =>
				unwrap(route().$patch({ param: { workspaceId: requiredWorkspace() }, json })),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: () =>
				unwrapEmpty(route().$delete({ param: { workspaceId: requiredWorkspace() } })),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: () => unwrap(route().test.$post({ param: { workspaceId: requiredWorkspace() } })),
			onSettled: refresh,
		}),
	};
}

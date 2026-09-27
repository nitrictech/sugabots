import type { NewSearchProvider, SearchProviderUpdate } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The workspace's search provider, or null when it has none. */
export function useSearchProvider() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["search-provider", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.searchProviders
							.get({ params: { workspace: workspaceId } })
							.pipe(Effect.map(({ provider }) => provider)),
						{ signal },
					)
			: skipToken,
	});
}

/**
 * useWebAccess fetches whether the current workspace's bots are offered the web
 * tools. Any workspace member may read it, unlike the provider itself. Its query
 * key starts with `["search-provider", workspaceId]`, the key that replacing,
 * updating, or removing the provider through useSearchProviderActions
 * invalidates, so each of those changes refetches it.
 */
export function useWebAccess() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["search-provider", workspaceId, "web-access"],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.searchProviders.webAccess({ params: { workspace: workspaceId } }),
						{ signal },
					)
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

	return {
		replace: useMutation({
			mutationFn: (json: NewSearchProvider) =>
				Effect.runPromise(
					client.api.searchProviders.replace({
						params: { workspace: requiredWorkspace() },
						payload: json,
					}),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: (json: SearchProviderUpdate) =>
				Effect.runPromise(
					client.api.searchProviders.update({
						params: { workspace: requiredWorkspace() },
						payload: json,
					}),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: () =>
				Effect.runPromise(
					client.api.searchProviders.remove({ params: { workspace: requiredWorkspace() } }),
				),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: () =>
				Effect.runPromise(
					client.api.searchProviders.test({ params: { workspace: requiredWorkspace() } }),
				),
			onSettled: refresh,
		}),
	};
}

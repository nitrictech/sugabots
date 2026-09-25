import type {
	GithubConnectionUpdate,
	NewGithubConnection,
	NewPodRepository,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The workspace's GitHub connection, or null when it has none. */
export function useGithubConnection() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["github-connection", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.github
							.get({ params: { workspace: workspaceId } })
							.pipe(Effect.map(({ connection }) => connection)),
						{ signal },
					)
			: skipToken,
	});
}

export function useGithubConnectionActions() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["github-connection", workspaceId] });
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}
	return {
		replace: useMutation({
			mutationFn: (payload: NewGithubConnection) =>
				Effect.runPromise(
					client.api.github.replace({ params: { workspace: requiredWorkspace() }, payload }),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: (payload: GithubConnectionUpdate) =>
				Effect.runPromise(
					client.api.github.update({ params: { workspace: requiredWorkspace() }, payload }),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: () =>
				Effect.runPromise(client.api.github.remove({ params: { workspace: requiredWorkspace() } })),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: () =>
				Effect.runPromise(client.api.github.test({ params: { workspace: requiredWorkspace() } })),
			onSettled: refresh,
		}),
	};
}

export function usePodRepositories(podId: string) {
	return useQuery({
		queryKey: ["pod-repositories", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.github.listPodRepositories({ params: { podId } }), { signal }),
	});
}

export function usePodRepositoryActions(podId: string) {
	const queryClient = useQueryClient();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ["pod-repositories", podId] });
	return {
		add: useMutation({
			mutationFn: (payload: NewPodRepository) =>
				Effect.runPromise(client.api.github.addPodRepository({ params: { podId }, payload })),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (repositoryId: string) =>
				Effect.runPromise(
					client.api.github.removePodRepository({ params: { podId, repositoryId } }),
				),
			onSuccess: refresh,
		}),
	};
}

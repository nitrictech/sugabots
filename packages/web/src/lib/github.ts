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
	const setup = useGithubSetup();
	return { ...setup, data: setup.data === undefined ? undefined : setup.data.connection };
}

/** The connection, and for an app, where to install it. */
export function useGithubSetup() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["github-connection", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.github.get({ params: { workspace: workspaceId } }), {
						signal,
					})
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
		startApp: useMutation({
			mutationFn: (organization: string) =>
				Effect.runPromise(
					client.api.github.startApp({
						params: { workspace: requiredWorkspace() },
						payload: organization ? { organization } : {},
					}),
				),
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

/** What can still be added to the pod, fetched only for someone who can add it. */
export function useAvailableRepositories(podId: string, wanted: boolean) {
	return useQuery({
		queryKey: ["available-repositories", podId],
		queryFn: wanted
			? ({ signal }) =>
					Effect.runPromise(client.api.github.listAvailableRepositories({ params: { podId } }), {
						signal,
					})
			: skipToken,
	});
}

export function usePodRepositoryActions(podId: string) {
	const queryClient = useQueryClient();
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["pod-repositories", podId] }),
			queryClient.invalidateQueries({ queryKey: ["available-repositories", podId] }),
		]);
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

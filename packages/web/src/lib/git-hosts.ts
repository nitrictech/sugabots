import type { GitHubAppForm, PodRepository } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** The workspace's git hosts, oldest first, and making, installing and removing them. */
export function useGitHosts() {
	const workspaceId = useWorkspace().workspace?.id;
	const queryClient = useQueryClient();
	const queryKey = ["git-hosts", workspaceId];
	function requiredWorkspace() {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	}
	return {
		hosts: useQuery({
			queryKey,
			queryFn: workspaceId
				? ({ signal }) =>
						Effect.runPromise(client.api.gitHosts.list({ params: { workspace: workspaceId } }), {
							signal,
						})
				: skipToken,
		}),
		/** Leaves for GitHub, which makes the app and comes back to install it. */
		makeGitHubApp: useMutation({
			mutationFn: async (organization: string | undefined) => {
				const form = await Effect.runPromise(
					client.api.gitHosts.startGitHubApp({
						params: { workspace: requiredWorkspace() },
						payload: organization ? { organization } : {},
					}),
				);
				postToGitHub(form);
			},
		}),
		install: useMutation({
			mutationFn: async (gitHostId: string) => {
				const { url } = await Effect.runPromise(
					client.api.gitHosts.installUrl({ params: { workspace: requiredWorkspace(), gitHostId } }),
				);
				window.location.assign(url);
			},
		}),
		remove: useMutation({
			mutationFn: (gitHostId: string) =>
				Effect.runPromise(
					client.api.gitHosts.remove({ params: { workspace: requiredWorkspace(), gitHostId } }),
				),
			onSuccess: () => queryClient.invalidateQueries({ queryKey }),
		}),
	};
}

/** GitHub takes a manifest only as a posted form, so the browser leaves with one. */
function postToGitHub({ url, manifest }: GitHubAppForm) {
	const form = document.createElement("form");
	form.method = "post";
	form.action = url;
	const field = document.createElement("input");
	field.type = "hidden";
	field.name = "manifest";
	field.value = manifest;
	form.append(field);
	document.body.append(form);
	form.submit();
}

/** The repositories the pod's agents work on, and changing them. */
export function usePodRepositories(podId: string) {
	const queryClient = useQueryClient();
	const queryKey = ["pod-repositories", podId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	return {
		repositories: useQuery({
			queryKey,
			queryFn: ({ signal }) =>
				Effect.runPromise(client.api.gitHosts.podRepositories({ params: { podId } }), { signal }),
		}),
		add: useMutation({
			mutationFn: (repository: PodRepository) =>
				Effect.runPromise(
					client.api.gitHosts.addRepository({ params: { podId }, payload: repository }),
				),
			...store,
		}),
		remove: useMutation({
			mutationFn: (repository: PodRepository) =>
				Effect.runPromise(
					client.api.gitHosts.removeRepository({ params: { podId }, payload: repository }),
				),
			...store,
		}),
	};
}

/** What the workspace's GitHub Apps reach, for someone adding a repository to the pod. */
export function useAvailableRepositories(podId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["available-repositories", podId],
		queryFn: enabled
			? ({ signal }) =>
					Effect.runPromise(client.api.gitHosts.availableRepositories({ params: { podId } }), {
						signal,
					})
			: skipToken,
		staleTime: 60_000,
	});
}

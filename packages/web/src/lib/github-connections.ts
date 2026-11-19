import type { GitHubAppForm } from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect } from "react";
import { client } from "@/api.ts";

/**
 * Leaves for GitHub to make the project its own GitHub App, owned by
 * `organization` or by the person; GitHub comes back to install it.
 */
export function useMakeGitHubApp(projectId: string) {
	return useMutation({
		mutationFn: async (organization: string | undefined) => {
			const form = await Effect.runPromise(
				client.api.gitHubConnections.start({
					params: { projectId },
					payload: organization ? { organization } : {},
				}),
			);
			postToGitHub(form);
		},
	});
}

/** Leaves for GitHub to install the connection's app, or to change which repositories it reaches. */
export function useInstallGitHubApp(projectId: string) {
	return useMutation({
		mutationFn: async (connectionId: string) => {
			const { url } = await Effect.runPromise(
				client.api.gitHubConnections.installUrl({ params: { projectId, connectionId } }),
			);
			window.location.assign(url);
		},
	});
}

const reachableRepositories = (projectId: string, connectionId: string) =>
	queryOptions({
		queryKey: ["github-reachable-repositories", projectId, connectionId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.gitHubConnections.reachableRepositories({ params: { projectId, connectionId } }),
				{ signal },
			),
		staleTime: 60_000,
	});

/** What a GitHub connection's app reaches, to choose the connection's repositories from. */
export function useReachableRepositories(projectId: string, connectionId: string) {
	return useQuery(reachableRepositories(projectId, connectionId));
}

/** Starts listing what the connection's app reaches, while `wanted`, so choosing from it is quick. */
export function usePrefetchReachableRepositories(
	projectId: string,
	connectionId: string,
	wanted: boolean,
) {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (wanted) void queryClient.prefetchQuery(reachableRepositories(projectId, connectionId));
	}, [queryClient, projectId, connectionId, wanted]);
}

/** A GitHub connection's repositories, and changing them. */
export function useConnectionRepositories(
	projectId: string | undefined,
	connectionId: string | undefined,
) {
	const queryClient = useQueryClient();
	const queryKey = ["connection-repositories", projectId, connectionId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	const params = () => {
		if (!projectId || !connectionId) throw new Error("No GitHub connection");
		return { projectId, connectionId };
	};
	return {
		repositories: useQuery({
			queryKey,
			queryFn:
				projectId && connectionId
					? ({ signal }) =>
							Effect.runPromise(
								client.api.gitHubConnections.repositories({ params: { projectId, connectionId } }),
								{ signal },
							)
					: skipToken,
		}),
		add: useMutation({
			mutationFn: (repository: string) =>
				Effect.runPromise(
					client.api.gitHubConnections.addRepository({
						params: params(),
						payload: { repository },
					}),
				),
			...store,
		}),
		remove: useMutation({
			mutationFn: (repository: string) =>
				Effect.runPromise(
					client.api.gitHubConnections.removeRepository({
						params: params(),
						payload: { repository },
					}),
				),
			...store,
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

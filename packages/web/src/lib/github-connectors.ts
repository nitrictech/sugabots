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
 * `organization` or by the member; GitHub comes back to install it.
 */
export function useMakeGitHubApp(projectId: string) {
	return useMutation({
		mutationFn: async (organization: string | undefined) => {
			const form = await Effect.runPromise(
				client.api.gitHubConnectors.start({
					params: { projectId },
					payload: organization ? { organization } : {},
				}),
			);
			postToGitHub(form);
		},
	});
}

/** Leaves for GitHub to install the connector's app, or to change which repositories it reaches. */
export function useInstallGitHubApp(projectId: string) {
	return useMutation({
		mutationFn: async (connectorId: string) => {
			const { url } = await Effect.runPromise(
				client.api.gitHubConnectors.installUrl({ params: { projectId, connectorId } }),
			);
			window.location.assign(url);
		},
	});
}

const reachableRepositories = (projectId: string, connectorId: string) =>
	queryOptions({
		queryKey: ["github-reachable-repositories", projectId, connectorId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.gitHubConnectors.reachableRepositories({ params: { projectId, connectorId } }),
				{ signal },
			),
		staleTime: 60_000,
	});

/** What a GitHub connector's app reaches, to choose the connector's repositories from. */
export function useReachableRepositories(projectId: string, connectorId: string) {
	return useQuery(reachableRepositories(projectId, connectorId));
}

/** Starts listing what the connector's app reaches, while `wanted`, so choosing from it is quick. */
export function usePrefetchReachableRepositories(
	projectId: string,
	connectorId: string,
	wanted: boolean,
) {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (wanted) void queryClient.prefetchQuery(reachableRepositories(projectId, connectorId));
	}, [queryClient, projectId, connectorId, wanted]);
}

/** A GitHub connector's repositories, and changing them. */
export function useConnectorRepositories(projectId: string, connectorId: string | undefined) {
	const queryClient = useQueryClient();
	const queryKey = ["connector-repositories", projectId, connectorId];
	const store = { onSuccess: (data: unknown) => queryClient.setQueryData(queryKey, data) };
	const params = () => {
		if (!connectorId) throw new Error("No GitHub connector");
		return { projectId, connectorId };
	};
	return {
		repositories: useQuery({
			queryKey,
			queryFn: connectorId
				? ({ signal }) =>
						Effect.runPromise(
							client.api.gitHubConnectors.repositories({ params: { projectId, connectorId } }),
							{ signal },
						)
				: skipToken,
		}),
		add: useMutation({
			mutationFn: (repository: string) =>
				Effect.runPromise(
					client.api.gitHubConnectors.addRepository({
						params: params(),
						payload: { repository },
					}),
				),
			...store,
		}),
		remove: useMutation({
			mutationFn: (repository: string) =>
				Effect.runPromise(
					client.api.gitHubConnectors.removeRepository({
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

import type { ToolCallPart } from "@sugabots/contracts";
import {
	type QueryClient,
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/*
 * A pod's artifacts. They refetch on every visit, and whenever a thread the
 * app is following reports a write (see `refreshArtifactsAfter`).
 */

/** The tools whose completed calls wrote an artifact. */
export const ARTIFACT_WRITING_TOOLS: ReadonlySet<string> = new Set([
	"artifact_write",
	"artifact_edit",
]);

/**
 * Refetches the artifacts on screen once `toolCall` has written one. Every
 * version is refetched, not only the current one: a reply's later writes go
 * over the version it made, so a card pinned to that version changes too.
 */
export function refreshArtifactsAfter(queries: QueryClient, toolCall: ToolCallPart): void {
	if (toolCall.status !== "completed" || !ARTIFACT_WRITING_TOOLS.has(toolCall.tool)) return;
	void queries.invalidateQueries({ queryKey: ["artifacts"] });
}

export function useArtifacts(podId: string) {
	return useQuery({
		queryKey: ["artifacts", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.artifacts.list({ params: { podId } }), { signal }),
		refetchOnMount: "always",
	});
}

/** The artifact at `version`, or at its current version when none is given. */
export function useArtifact(podId: string, artifactId: string, version?: number) {
	return useQuery({
		...artifactQuery(podId, artifactId, version),
		refetchOnMount: version === undefined ? "always" : true,
	});
}

/** Fetches an artifact's current version when asked, such as to download it from the pod's list. */
export function useFetchArtifact(podId: string) {
	const queries = useQueryClient();
	return (artifactId: string) => queries.fetchQuery(artifactQuery(podId, artifactId));
}

function artifactQuery(podId: string, artifactId: string, version?: number) {
	return queryOptions({
		queryKey: ["artifacts", podId, artifactId, version ?? "current"],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				version === undefined
					? client.api.artifacts.get({ params: { podId, artifactId } })
					: client.api.artifacts.getVersion({ params: { podId, artifactId, version } }),
				{ signal },
			),
	});
}

/** Deletes one of the pod's artifacts, then refreshes the pod's list. */
export function useDeleteArtifact(podId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (artifactId: string) =>
			Effect.runPromise(client.api.artifacts.remove({ params: { podId, artifactId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["artifacts", podId], exact: true }),
	});
}

export function useArtifactVersions(podId: string, artifactId: string) {
	return useQuery({
		queryKey: ["artifacts", podId, artifactId, "versions"],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.artifacts.versions({ params: { podId, artifactId } }), {
				signal,
			}),
		refetchOnMount: "always",
	});
}

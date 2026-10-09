import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/*
 * A pod's artifacts. Nothing tells the web app when a bot writes one yet, so
 * these refetch when the window regains focus and on every visit.
 */

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
		queryKey: ["artifacts", podId, artifactId, version ?? "current"],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				version === undefined
					? client.api.artifacts.get({ params: { podId, artifactId } })
					: client.api.artifacts.getVersion({ params: { podId, artifactId, version } }),
				{ signal },
			),
		refetchOnMount: version === undefined ? "always" : true,
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

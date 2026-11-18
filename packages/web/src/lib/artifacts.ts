import { ARTIFACT_WRITING_TOOLS, type ToolCallPart } from "@sugabots/contracts";
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
 * Files bots made: a channel's, or a bot's own. They refetch on every visit,
 * and whenever a thread the app is following reports a write (see
 * `refreshArtifactsAfter`).
 */

/** Whose files a list shows: a channel's, made in its conversations, or a bot's, made in its tasks. */
export type ArtifactScope = { kind: "pod"; podId: string } | { kind: "agent"; agentId: string };

/**
 * Refetches the files on screen once `toolCall` has written one. Every
 * version is refetched, not only the current one: a reply's later writes go
 * over the version it made, so a card pinned to that version changes too.
 */
export function refreshArtifactsAfter(queries: QueryClient, toolCall: ToolCallPart): void {
	if (toolCall.status !== "completed" || !ARTIFACT_WRITING_TOOLS.has(toolCall.tool)) return;
	void queries.invalidateQueries({ queryKey: ["artifacts"] });
}

const scopeKey = (scope: ArtifactScope) =>
	scope.kind === "pod" ? ["artifacts", "pod", scope.podId] : ["artifacts", "agent", scope.agentId];

export function useArtifacts(scope: ArtifactScope) {
	return useQuery({
		queryKey: scopeKey(scope),
		queryFn: ({ signal }) =>
			Effect.runPromise(
				scope.kind === "pod"
					? client.api.artifacts.listInPod({ params: { podId: scope.podId } })
					: client.api.artifacts.listForAgent({ params: { agentId: scope.agentId } }),
				{ signal },
			),
		refetchOnMount: "always",
	});
}

/** The file at `version`, or at its current version when none is given. */
export function useArtifact(artifactId: string, version?: number) {
	return useQuery({
		...artifactQuery(artifactId, version),
		refetchOnMount: version === undefined ? "always" : true,
	});
}

/** Fetches a file's current version when asked, such as to download it from a list. */
export function useFetchArtifact() {
	const queries = useQueryClient();
	return (artifactId: string) => queries.fetchQuery(artifactQuery(artifactId));
}

function artifactQuery(artifactId: string, version?: number) {
	return queryOptions({
		queryKey: ["artifacts", "one", artifactId, version ?? "current"],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				version === undefined
					? client.api.artifacts.get({ params: { artifactId } })
					: client.api.artifacts.getVersion({ params: { artifactId, version } }),
				{ signal },
			),
	});
}

/** Deletes a file, then refreshes the lists that show it. */
export function useDeleteArtifact() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (artifactId: string) =>
			Effect.runPromise(client.api.artifacts.remove({ params: { artifactId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["artifacts"] }),
	});
}

/** One version of one page a bot made. */
export interface PageAt {
	artifactId: string;
	version: number;
}

/**
 * Where the page loads from on the content origin, or `null` when none is set,
 * asked for only once `enabled`. An address works for ten minutes and a new
 * one reloads the frame showing it, so each `load` (one frame showing one
 * content of the page) has its own: never shared, never refetched on its own,
 * kept apart from the files the app refreshes after writes, and dropped
 * once its frame is gone. While a new load's address is asked for, the last
 * one's stays if it was for the same file, so the page stays on screen.
 */
export function usePageAddress(
	{ artifactId, version }: PageAt,
	{ load, enabled }: { load: string; enabled: boolean },
) {
	return useQuery({
		queryKey: ["artifact-pages", artifactId, version, load],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.artifacts.pageAddress({ params: { artifactId, version } }), {
				signal,
			}),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === artifactId ? previous : undefined,
	});
}

export function useArtifactVersions(artifactId: string) {
	return useQuery({
		queryKey: ["artifacts", "one", artifactId, "versions"],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.artifacts.versions({ params: { artifactId } }), { signal }),
		refetchOnMount: "always",
	});
}

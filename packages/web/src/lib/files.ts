import { FILE_WRITING_TOOLS, type ToolCallPart } from "@sugabots/contracts";
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
 * Files: a project's, a bot's being its default project's, each opened by version. They refetch on every visit, and whenever a chat the
 * app is following reports a write (see `refreshFilesAfter`).
 */

/**
 * Refetches the files on screen once `toolCall` has written one. Every
 * version is refetched, not only the current one: a reply's later writes go
 * over the version it made, so a card pinned to that version changes too.
 */
export function refreshFilesAfter(queries: QueryClient, toolCall: ToolCallPart): void {
	if (toolCall.status !== "completed" || !FILE_WRITING_TOOLS.has(toolCall.tool)) return;
	void queries.invalidateQueries({ queryKey: ["files"] });
}

/** The cache key of the project `projectId`'s list of files. */
export const filesKey = (projectId: string) => ["files", "project", projectId];

/** The cache key of one file at `version`, or at its current version when none is given. */
export const fileKey = (fileId: string, version?: number) => [
	"files",
	"one",
	fileId,
	version ?? "current",
];

/** The files from the chats of the project `projectId`, which for a bot is its default project. */
export function useFiles(projectId: string) {
	return useQuery({
		queryKey: filesKey(projectId),
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.files.listInProject({ params: { projectId } }), { signal }),
		refetchOnMount: "always",
	});
}

/** The file at `version`, or at its current version when none is given. */
export function useFile(fileId: string, version?: number) {
	return useQuery({
		...fileQuery(fileId, version),
		refetchOnMount: version === undefined ? "always" : true,
	});
}

function fileQuery(fileId: string, version?: number) {
	return queryOptions({
		queryKey: fileKey(fileId, version),
		queryFn: ({ signal }) =>
			Effect.runPromise(
				version === undefined
					? client.api.files.get({ params: { fileId } })
					: client.api.files.getVersion({ params: { fileId, version } }),
				{ signal },
			),
	});
}

/** Deletes a file, then refreshes the lists that show it. */
export function useDeleteFile() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (fileId: string) =>
			Effect.runPromise(client.api.files.remove({ params: { fileId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["files"] }),
	});
}

/** One version of one page a bot made. */
export interface PageAt {
	fileId: string;
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
	{ fileId, version }: PageAt,
	{ load, enabled }: { load: string; enabled: boolean },
) {
	return useQuery({
		queryKey: ["file-pages", fileId, version, load],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.files.pageAddress({ params: { fileId, version } }), {
				signal,
			}),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === fileId ? previous : undefined,
	});
}

export function useFileVersions(fileId: string) {
	return useQuery({
		queryKey: ["files", "one", fileId, "versions"],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.files.versions({ params: { fileId } }), { signal }),
		refetchOnMount: "always",
	});
}

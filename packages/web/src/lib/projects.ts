import type { NewProject, Project, ProjectUpdate } from "@sugabots/contracts";
import {
	type QueryClient,
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

/**
 * The projects this member sees: those they are in, which for an
 * administrator is every one, and the public ones they could join
 * (`isMember` tells them apart). Each one carries what they may do in it, as
 * the API resolves it.
 *
 * The sidebar, the directory and the routes share this one query: a route
 * resolves its `:project` slug out of the same cached list.
 */
export function useProjects() {
	const workspace = useWorkspace();
	const query = useQuery(projectsQuery(workspace.workspace?.id));

	return {
		...query,
		/** Still resolving if we do not even know the workspace yet. */
		isPending: workspace.isPending || query.isPending,
	};
}

/** The projects of one workspace, which need not be the one being looked at. */
export function projectsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["projects", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.projects.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

export function findProject(
	projects: readonly Project[] | undefined,
	slug: string,
): Project | undefined {
	return projects?.find((project) => project.slug === slug);
}

/** Makes a project, with its creator in it, and puts it in the sidebar. */
export function useCreateProject() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const requiredWorkspaceId = useRequiredWorkspaceId();

	return useMutation({
		mutationFn: (input: NewProject) =>
			Effect.runPromise(
				client.api.projects.create({
					params: { workspace: requiredWorkspaceId() },
					payload: input,
				}),
			),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["projects", workspaceId] }),
	});
}

export function useUpdateProject(projectId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: ProjectUpdate) =>
			Effect.runPromise(client.api.projects.update({ params: { projectId }, payload: input })),
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["projects", workspaceId] }),
				// A new lead bot joins the project's bots.
				queries.invalidateQueries({ queryKey: ["project-bots", projectId] }),
			]),
	});
}

export function useDeleteProject() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (projectId: string) =>
			Effect.runPromise(client.api.projects.remove({ params: { projectId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["projects", workspaceId] }),
	});
}

/** Who is in the project; nothing is asked while `projectId` is undefined. */
export function useProjectMembers(projectId: string | undefined) {
	return useQuery({
		queryKey: ["project-members", projectId],
		queryFn: projectId
			? ({ signal }) =>
					Effect.runPromise(client.api.projects.listMembers({ params: { projectId } }), { signal })
			: skipToken,
	});
}

/**
 * The members who reach the project: in a project members made, its members; in
 * a bot's default project, whoever reaches the bot.
 */
export function useMembersReachingProject(projectId: string) {
	return useQuery({
		queryKey: ["project-members", projectId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.projects.listMembersReaching({ params: { projectId } }), {
				signal,
			}),
	});
}

/**
 * Adds a member in the workspace to a project, or takes them out. One mutation for both
 * directions because the caller is one list with an add and a remove on it.
 */
export function usePlaceProjectMember(projectId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: ({ memberId, member }: { memberId: string; member: boolean }) =>
			Effect.runPromise(
				member
					? client.api.projects.addMember({ params: { projectId }, payload: { memberId } })
					: client.api.projects.removeMember({ params: { projectId, memberId } }),
			),
		onSuccess: () => refreshMembership(queries, workspaceId, projectId),
	});
}

/** Takes you out of a project, and so out of the sidebar. */
export function useLeaveProject(projectId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: () => Effect.runPromise(client.api.projects.leave({ params: { projectId } })),
		onSuccess: () => refreshMembership(queries, workspaceId, projectId),
	});
}

/** Puts you in a public project, and so in the sidebar. */
export function useJoinProject() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (projectId: string) =>
			Effect.runPromise(client.api.projects.join({ params: { projectId } })),
		onSuccess: (_joined, projectId) => refreshMembership(queries, workspaceId, projectId),
	});
}

/**
 * Fetches again what shows who is in the project `projectId`: the projects,
 * which count its members, its members, and who reaches it.
 */
function refreshMembership(
	queries: QueryClient,
	workspaceId: string | undefined,
	projectId: string,
) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["projects", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["project-members", projectId] }),
		queries.invalidateQueries({ queryKey: ["project-members", projectId] }),
	]);
}

/** The bots added to the project; nothing is asked while `projectId` is undefined. */
export function useProjectBots(projectId: string | undefined) {
	return useQuery({
		queryKey: ["project-bots", projectId],
		queryFn: projectId
			? ({ signal }) =>
					Effect.runPromise(client.api.projects.listBots({ params: { projectId } }), { signal })
			: skipToken,
	});
}

/** Adds a public bot to the project, or takes one out. */
export function usePlaceProjectBot(projectId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: ({ botId, added }: { botId: string; added: boolean }) =>
			Effect.runPromise(
				added
					? client.api.projects.addBot({ params: { projectId }, payload: { botId } })
					: client.api.projects.removeBot({ params: { projectId, botId } }),
			),
		// The list of projects counts each one's bots.
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["projects", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["project-bots", projectId] }),
			]),
	});
}

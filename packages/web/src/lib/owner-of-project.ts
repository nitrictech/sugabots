import type { Bot, Project } from "@sugabots/contracts";
import { useBots } from "@/lib/bots.ts";
import { useProjects } from "@/lib/projects.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";

/**
 * Whose project `projectId` is, as its pages show it: the bot whose default
 * project it is, else the project itself while the person is in it, since
 * only its members open a project's pages. Undefined for a project neither list
 * has, or not yet.
 */
export function ownerOfProject(
	projectId: string,
	bots: readonly Bot[] | undefined,
	projects: readonly Project[] | undefined,
): ResourceOwner | undefined {
	const bot = bots?.find((one) => one.defaultProjectId === projectId);
	if (bot) return { bot };
	const project = projects?.find((one) => one.id === projectId && one.isMember);
	return project && { project };
}

/**
 * Whose project `projectId` is (see `ownerOfProject`), from the roster and
 * the projects listed.
 */
export function useOwnerOfProject(projectId: string): ResourceOwner | undefined {
	const { bots } = useBots();
	const { data: projects } = useProjects();
	return ownerOfProject(projectId, bots, projects);
}

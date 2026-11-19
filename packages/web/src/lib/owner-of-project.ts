import { useBots } from "@/lib/bots.ts";
import { useProjects } from "@/lib/projects.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";

/**
 * Whose project `projectId` is, as its pages show it: the bot whose default
 * project it is, or the project itself. Undefined until the roster and the
 * project list have it, and for a project the person can't see.
 */
export function useOwnerOfProject(projectId: string): ResourceOwner | undefined {
	const { bots } = useBots();
	const { data: projects } = useProjects();
	const bot = bots?.find((one) => one.defaultProjectId === projectId);
	if (bot) return { bot };
	const project = projects?.find((one) => one.id === projectId);
	return project && { project };
}

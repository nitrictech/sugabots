import { useParams } from "@tanstack/react-router";
import { useBotWithHandle } from "@/lib/bots.ts";
import { findProject, useProjects } from "@/lib/projects.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";

/** The bot an address under `/bots/$bot` names, once the roster has it. */
export function useBotRouteOwner(): ResourceOwner | undefined {
	const { bot: handle } = useParams({ from: "/$workspace/bots/$bot" });
	const { bot } = useBotWithHandle(handle);
	return bot && { bot };
}

/** The project an address under `/projects/$project` names, once loaded. */
export function useProjectRouteOwner(): ResourceOwner | undefined {
	const { project: slug } = useParams({ from: "/$workspace/projects/$project" });
	const project = findProject(useProjects().data, slug);
	return project && { project };
}

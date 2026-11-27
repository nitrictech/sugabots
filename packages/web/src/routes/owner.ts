import type { Bot, Project } from "@sugabots/contracts";
import { useParams } from "@tanstack/react-router";
import { useBotAtAddress } from "@/lib/bots.ts";
import { findProject, useProjects } from "@/lib/projects.ts";

/** The bot an address under `/bots/$bot` names, once the roster has it. */
export function useBotRouteOwner(): { bot: Bot } | undefined {
	const { bot: address } = useParams({ from: "/$workspace/bots/$bot" });
	const { bot } = useBotAtAddress(address);
	return bot && { bot };
}

/** The project an address under `/projects/$project` names, once loaded. */
export function useProjectRouteOwner(): { project: Project } | undefined {
	const { project: slug } = useParams({ from: "/$workspace/projects/$project" });
	const project = findProject(useProjects().data, slug);
	return project && { project };
}

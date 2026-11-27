import type { ApprovalRequest } from "@sugabots/contracts";
import { Globe } from "lucide-react";
import { useApprovalConnector } from "@/lib/connectors.ts";
import { formatTimeAfterVerb } from "@/lib/list-time.ts";
import { useProjects } from "@/lib/projects.ts";
import { connectorLabel, HOST_REQUEST_TOOL, splitToolKey, stepLabel } from "@/lib/tool-names.ts";

export function hostRequestPresentation(tool: string, botName: string) {
	if (tool !== HOST_REQUEST_TOOL) return undefined;
	return {
		description: `${botName} wants the project's computer to reach a new host`,
		icon: Globe,
	};
}

/**
 * What an approval request would use and do, as its row and its page show
 * them: its tool source's connector for its mark, the tool source's name, and
 * the action. A step that is not a connector's tool is named by its action.
 */
export function useApprovalToolSource(request: ApprovalRequest, canApprove: boolean) {
	const { handle, name } = splitToolKey(request.call.tool);
	const connector = useApprovalConnector(
		request.call,
		request.projectId,
		request.bot.id,
		canApprove,
	);
	const action = stepLabel(request.call.tool, name);
	return {
		connector,
		hostRequest: hostRequestPresentation(request.call.tool, request.bot.name),
		toolSourceName: handle ? connectorLabel(handle, connector?.name) : action,
		action,
	};
}

/**
 * The project an approval request was asked in, once the projects are loaded,
 * and where and when it was asked, as its row and its page say it: "in Launch
 * at 9:14", or "at 9:14" outside a project.
 */
export function useAskedIn(request: ApprovalRequest) {
	const { data: projects } = useProjects();
	const project = projects?.find((candidate) => candidate.id === request.projectId);
	const projectName = request.projectName ?? project?.name;
	const askedIn = [
		projectName && `in ${projectName}`,
		formatTimeAfterVerb(new Date(request.call.startedAt), new Date()),
	]
		.filter(Boolean)
		.join(" ");
	return { project, askedIn };
}

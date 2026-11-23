import type { ApprovalRequest } from "@sugabots/contracts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { formatTimeAfterVerb } from "@/lib/list-time.ts";
import { useProjects } from "@/lib/projects.ts";
import { connectionLabel, splitToolKey, stepLabel } from "@/lib/tool-names.ts";

/**
 * What an approval request would use and do, as its row and its page show
 * them: the app's look for its mark, the app's name, and the action. A step
 * that is not a connection's tool is named by its action.
 */
export function useApprovalApp(request: ApprovalRequest) {
	const looksOf = useConnectionLooks([request.bot.id], request.projectId);
	const { handle, name } = splitToolKey(request.call.tool);
	const look = looksOf(request.bot.id).get(handle);
	const action = stepLabel(request.call.tool, name);
	return { look, appName: handle ? connectionLabel(handle, look?.name) : action, action };
}

/**
 * The project an approval request was asked in, once the projects are loaded,
 * and where and when it was asked, as its row and its page say it: "in Launch
 * at 9:14", or "at 9:14" outside a project.
 */
export function useAskedIn(request: ApprovalRequest) {
	const { data: projects } = useProjects();
	const project = projects?.find((candidate) => candidate.id === request.projectId);
	const askedIn = [
		project && `in ${project.name}`,
		formatTimeAfterVerb(new Date(request.call.startedAt), new Date()),
	]
		.filter(Boolean)
		.join(" ");
	return { project, askedIn };
}

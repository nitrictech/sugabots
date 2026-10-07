import type { ApprovalRequest } from "@sugabots/contracts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { connectionLabel, splitToolKey, stepLabel } from "@/lib/tool-names.ts";

/**
 * What an approval request would use and do, as its row and its page show
 * them: the app's look for its mark, the app's name, and the action. A step
 * that is not a connection's tool is named by its action.
 */
export function useApprovalApp(request: ApprovalRequest) {
	const looks = useConnectionLooks(request.podId);
	const { handle, name } = splitToolKey(request.call.tool);
	const look = looks.get(handle);
	const action = stepLabel(request.call.tool, name);
	return { look, appName: handle ? connectionLabel(handle, look?.name) : action, action };
}

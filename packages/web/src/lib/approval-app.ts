import type { ApprovalRequest } from "@sugabots/contracts";
import { useChannels } from "@/lib/channels.ts";
import { useConnectionLooks } from "@/lib/connections.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { connectionLabel, splitToolKey, stepLabel } from "@/lib/tool-names.ts";

/**
 * What an approval request would use and do, as its row and its page show
 * them: the app's look for its mark, the app's name, and the action. A step
 * that is not a connection's tool is named by its action.
 */
export function useApprovalApp(request: ApprovalRequest) {
	const looks = useConnectionLooks([request.bot.id]);
	const { handle, name } = splitToolKey(request.call.tool);
	const look = looks.get(handle);
	const action = stepLabel(request.call.tool, name);
	return { look, appName: handle ? connectionLabel(handle, look?.name) : action, action };
}

/**
 * The channel an approval request was asked in, once the channels are loaded,
 * and where and when it was asked, as its row and its page say it: "in Launch
 * at 9:14", or "at 9:14" outside a channel.
 */
export function useAskedIn(request: ApprovalRequest) {
	const { data: channels } = useChannels();
	const channel = channels?.find((candidate) => candidate.id === request.channelId);
	const askedIn = [
		channel && `in ${channel.name}`,
		`at ${formatListTime(new Date(request.call.startedAt), new Date())}`,
	]
		.filter(Boolean)
		.join(" ");
	return { channel, askedIn };
}

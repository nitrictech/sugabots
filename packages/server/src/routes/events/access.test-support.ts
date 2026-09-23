import { threadChannel, workspaceChannel } from "@sugabots/contracts";
import type { ChannelAccess } from "./access.ts";

export function openChannelAccess(): ChannelAccess {
	return {
		async workspace(_session, workspaceId) {
			return workspaceChannel(workspaceId);
		},
		async thread(_session, threadId) {
			return threadChannel(threadId);
		},
	};
}

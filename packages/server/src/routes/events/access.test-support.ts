import { threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Effect } from "effect";
import type { ChannelAccess } from "./access.ts";

export function openChannelAccess(): ChannelAccess {
	return {
		workspace: (workspaceId) => Effect.succeed(workspaceChannel(workspaceId)),
		thread: (threadId) => Effect.succeed(threadChannel(threadId)),
	};
}

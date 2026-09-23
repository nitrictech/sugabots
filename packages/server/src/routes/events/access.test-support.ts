import { threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Effect } from "effect";
import type { ChannelAccess } from "./access.ts";

export function openChannelAccess(): ChannelAccess {
	return {
		workspace: (_session, workspaceId) => Effect.succeed(workspaceChannel(workspaceId)),
		thread: (_session, threadId) => Effect.succeed(threadChannel(threadId)),
	};
}

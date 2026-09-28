import { threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Effect } from "effect";
import type { ChannelAccess } from "./access.ts";

/** Grants nothing, so a stream route is never open by omission. */
export const closedChannelAccess: ChannelAccess.Interface = {
	workspace: () => Effect.undefined,
	thread: () => Effect.undefined,
	reachesPod: () => Effect.succeed(false),
};

/** Grants every channel, for stream cases that are not about who may listen. */
export const openChannelAccess: ChannelAccess.Interface = {
	workspace: (workspaceId) => Effect.succeed(workspaceChannel(workspaceId)),
	thread: (threadId) => Effect.succeed(threadChannel(threadId)),
	reachesPod: () => Effect.succeed(true),
};

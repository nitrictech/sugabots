import { conversationStream, personStream, workspaceStream } from "@sugabots/contracts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Effect } from "effect";
import type { StreamAccess } from "./access.ts";

/** Grants nothing, so a stream route is never open by omission. */
export const closedStreamAccess: StreamAccess.Interface = {
	workspace: () => Effect.undefined,
	conversation: () => Effect.undefined,
	me: () => Effect.undefined,
	hears: () => Effect.succeed(false),
};

/** Grants every stream, for stream cases that are not about who may listen. */
export const openStreamAccess: StreamAccess.Interface = {
	workspace: (workspaceId) => Effect.succeed(workspaceStream(workspaceId)),
	conversation: (conversationId) => Effect.succeed(conversationStream(conversationId)),
	me: () => Effect.map(CurrentActor.Service, ({ userId }) => personStream(userId)),
	hears: () => Effect.succeed(true),
};

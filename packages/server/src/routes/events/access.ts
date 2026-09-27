import { type Channel, threadChannel, workspaceChannel } from "@sugabots/contracts";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import type { Database } from "@sugabots/core/database/database";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Effect } from "effect";

/**
 * Who may listen to what.
 *
 * ADR 001: a stream route authorises exactly like the REST route for the same
 * resource — the same `Authorization` and the same thread visibility, so a
 * demotion that closes a REST route closes the stream with it.
 *
 * Each function answers with the channel to subscribe to, or
 * `undefined` when the caller may not have it — returning the channel rather
 * than a yes or no because for a thread the two are different questions: the
 * events of a thread publish on its **root** thread's channel, so resolving the
 * root is part of the same lookup.
 *
 * It is an interface so stream routes can be tested without a database.
 */
export interface ChannelAccess {
	/** `workspaceRef` is the workspace's id or slug; the channel is always named by id. */
	workspace(
		userId: string,
		workspaceRef: string,
	): Effect.Effect<Channel | undefined, never, Database>;
	thread(userId: string, threadId: string): Effect.Effect<Channel | undefined, never, Database>;
}

export function channelAccess(
	authorization: Authorization,
	threads: Pick<ThreadStore, "visibleThreadId">,
): ChannelAccess {
	return {
		workspace: (userId, workspaceRef) =>
			authorization.workspace(userId, workspaceRef, "workspace.read").pipe(
				Effect.match({
					onSuccess: ({ workspaceId }) => workspaceChannel(workspaceId),
					onFailure: () => undefined,
				}),
			),

		thread: (userId, threadId) =>
			Effect.map(threads.visibleThreadId(threadId, userId), (visibleId) =>
				visibleId ? threadChannel(visibleId) : undefined,
			),
	};
}

/** Grants nothing. The default, so a stream route is never open by omission. */
export function closedChannelAccess(): ChannelAccess {
	return {
		workspace: () => Effect.undefined,
		thread: () => Effect.undefined,
	};
}

import { type Channel, threadChannel, workspaceChannel } from "@sugabots/contracts";
import type { Authorization } from "@sugabots/core/workspaces/authorization";
import type { CurrentActor } from "@sugabots/core/workspaces/current-actor";
import type { Visibility } from "@sugabots/core/workspaces/visibility";
import { Effect } from "effect";

/**
 * Who may listen to what.
 *
 * ADR 001: a stream route authorises exactly like the REST route for the same
 * resource — the same `Authorization` and the same `Visibility`, so a
 * demotion that closes a REST route closes the stream with it.
 *
 * Each function answers, for the current actor, with the channel to subscribe
 * to, or `undefined` when they may not have it. A thread's events go on that
 * thread's own channel, and a workspace channel carries what its lists need
 * (`ThreadFeed` in core decides both).
 *
 * It is an interface so stream routes can be tested without a database.
 */
export interface ChannelAccess {
	/** `workspaceRef` is the workspace's id or slug; the channel is always named by id. */
	workspace(workspaceRef: string): Effect.Effect<Channel | undefined, never, CurrentActor.Service>;
	thread(threadId: string): Effect.Effect<Channel | undefined, never, CurrentActor.Service>;
}

export function channelAccess(
	authorization: Authorization.Interface,
	visibility: Visibility.Interface,
): ChannelAccess {
	return {
		workspace: (workspaceRef) =>
			authorization.workspace(workspaceRef, "workspace.read").pipe(
				Effect.match({
					onSuccess: ({ workspaceId }) => workspaceChannel(workspaceId),
					onFailure: () => undefined,
				}),
			),

		thread: (threadId) =>
			visibility.thread(threadId).pipe(
				Effect.match({
					onSuccess: ({ thread }) => threadChannel(thread.id),
					onFailure: () => undefined,
				}),
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

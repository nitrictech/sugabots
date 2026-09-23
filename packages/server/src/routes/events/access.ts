import { type Channel, threadChannel, workspaceChannel } from "@sugabots/contracts";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import type { RunEffect } from "@sugabots/core/database/database";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Effect } from "effect";
import type { Session } from "../../auth/session.ts";

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
	workspace(session: Session, workspaceId: string): Promise<Channel | undefined>;
	thread(session: Session, threadId: string): Promise<Channel | undefined>;
}

export function channelAccess(
	authorization: Authorization,
	threads: Pick<ThreadStore, "visibleThreadId">,
	run: RunEffect,
): ChannelAccess {
	return {
		async workspace(session, workspaceId) {
			const allowed = await run(
				Effect.result(authorization.workspace(session.user.id, workspaceId, "workspace.read")),
			);
			return allowed._tag === "Success" ? workspaceChannel(workspaceId) : undefined;
		},

		async thread(session, threadId) {
			const visibleId = await run(threads.visibleThreadId(threadId, session.user.id));
			return visibleId ? threadChannel(visibleId) : undefined;
		},
	};
}

/** Grants nothing. The default, so a stream route is never open by omission. */
export function closedChannelAccess(): ChannelAccess {
	return {
		async workspace() {
			return undefined;
		},
		async thread() {
			return undefined;
		},
	};
}

export * as ChannelAccess from "./access.ts";

import { type Channel, threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Authorization } from "@sugabots/core/authorization/authorization";
import type { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Visibility } from "@sugabots/core/authorization/visibility";
import { Context, Effect, Layer } from "effect";

/**
 * Who may listen to what.
 *
 * A stream route authorises exactly like the REST route for the same
 * resource — the same `Authorization` and the same `Visibility`, so a
 * demotion that closes a REST route closes the stream with it.
 *
 * Each function answers, for the current actor, with the channel to subscribe
 * to, or `undefined` when they may not have it. A thread's events go on that
 * thread's own channel, and a workspace channel carries what its lists need
 * (`ThreadFeed` in core decides both).
 */
export interface Interface {
	/** `workspaceRef` is the workspace's id or slug; the channel is always named by id. */
	workspace(workspaceRef: string): Effect.Effect<Channel | undefined, never, CurrentActor.Service>;
	thread(threadId: string): Effect.Effect<Channel | undefined, never, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/ChannelAccess",
) {}

export const make = Effect.gen(function* () {
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	return Service.of({
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
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

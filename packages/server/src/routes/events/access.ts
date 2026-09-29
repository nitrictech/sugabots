export * as ChannelAccess from "./access.ts";

import { type Channel, memberChannel, threadChannel, workspaceChannel } from "@sugabots/contracts";
import { Authorization } from "@sugabots/core/authorization/authorization";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Visibility } from "@sugabots/core/authorization/visibility";
import { query, serviceOperations } from "@sugabots/core/database/database";
import { pod } from "@sugabots/core/database/schema";
import { and, eq } from "drizzle-orm";
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
	/**
	 * The current actor's own channel in the workspace `workspaceRef` names, by
	 * its id or its slug. Nobody is given anyone else's.
	 */
	member(workspaceRef: string): Effect.Effect<Channel | undefined, never, CurrentActor.Service>;
	/**
	 * Whether the current actor reaches the pod `podId`, by `Visibility`'s
	 * rule, and so may hear what a workspace channel says of its threads.
	 */
	reachesPod(podId: string): Effect.Effect<boolean, never, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/ChannelAccess",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChannelAccess");
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

		member: (workspaceRef) =>
			Effect.gen(function* () {
				const { userId } = yield* CurrentActor.Service;
				return yield* authorization.workspace(workspaceRef, "workspace.read").pipe(
					Effect.match({
						onSuccess: ({ workspaceId }) => memberChannel(workspaceId, userId),
						onFailure: () => undefined,
					}),
				);
			}),

		thread: (threadId) =>
			visibility.thread(threadId).pipe(
				Effect.match({
					onSuccess: ({ thread }) => threadChannel(thread.id),
					onFailure: () => undefined,
				}),
			),

		reachesPod: (podId) =>
			operation(
				"reachesPod",
				Effect.gen(function* () {
					const reaches = yield* visibility.reachesPod;
					const [reached] = yield* query((db) =>
						db
							.select({ id: pod.id })
							.from(pod)
							.where(and(eq(pod.id, podId), reaches(pod.id)))
							.limit(1),
					);
					return reached !== undefined;
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

export * as Visibility from "./visibility.ts";

import { and, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { thread } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import {
	type PodStanding,
	ResourceHidden,
	reachedPodStandingsFor,
	reachesPodFor,
	requireReach,
	type ThreadStanding,
	threadStandingFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";

/**
 * What the current actor can see. A pod is seen by whoever reaches it, and
 * everything inside it, its conversations and threads included, by whoever sees the
 * pod. Lists are scoped by `reachesPodFor`, the `pod.read` rule that
 * `Authorization` checks for one pod written as SQL, so a list holds the pods
 * that reading each one directly would allow.
 */
export interface Interface {
	/** The rule for the pods the actor reaches, for queries that scope a list. */
	readonly reachesPod: Effect.Effect<ReachesPod, never, CurrentActor.Service>;
	/** The pods the actor reaches in the workspace, by name, with their standing in each. */
	readonly pods: (workspaceId: string) => Effect.Effect<PodStanding[], never, CurrentActor.Service>;
	/** The thread, with the actor's standing in its pod. */
	readonly thread: (
		threadId: string,
	) => Effect.Effect<ThreadStanding, ResourceHidden, CurrentActor.Service>;
	/** The conversation, by its id: a thread whose type is `conversation`. */
	readonly conversation: (
		conversationId: string,
	) => Effect.Effect<schema.ThreadRow, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Visibility") {}

/**
 * SQL for "somebody reaches this pod", given the column naming the pod:
 * `thread.podId`, `agent.podId`, `pod.id`.
 */
export type ReachesPod = (podId: SQLWrapper) => SQL<boolean>;

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Visibility");
	return Service.of({
		reachesPod: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(podId) =>
					reachesPodFor(podId, userId),
		),

		pods: (workspaceId) =>
			operation(
				"pods",
				Effect.flatMap(CurrentActor.Service, ({ userId }) =>
					query((db) => reachedPodStandingsFor(db, workspaceId, userId)),
				),
			),

		thread: (threadId) =>
			operation(
				"thread",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => threadStandingFor(db, threadId, userId));
					return yield* requireReach(standing, "thread");
				}),
			),

		conversation: (conversationId) =>
			operation(
				"conversation",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const [row] = isUuid(conversationId)
						? yield* query((db) =>
								db
									.select()
									.from(thread)
									.where(
										and(
											eq(thread.id, conversationId),
											eq(thread.type, "conversation"),
											reachesPodFor(thread.podId, userId),
										),
									)
									.limit(1),
							)
						: [];
					if (!row) return yield* new ResourceHidden({ resource: "conversation" });
					return row;
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

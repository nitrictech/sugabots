export * as Visibility from "./visibility.ts";

import { and, eq, inArray, type SQL, type SQLWrapper } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { CONVERSATION_TYPES, thread } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import {
	type PodStanding,
	ResourceHidden,
	reachedPodStandingsFor,
	reachesAgentFor,
	reachesPodFor,
	reachesThreadFor,
	type ThreadReachColumns,
	type ThreadStanding,
	threadStandingFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";

/**
 * What the current actor can see. A channel's conversations are seen by the
 * people in it; a bot, and its tasks and automations, by whoever reaches the
 * bot; a collaboration by whoever sees the conversation it was opened from;
 * a direct message by the people in it. Lists are scoped by
 * `reachesPodFor`, `reachesAgentFor` and `reachesThreadFor`, the rules
 * `Authorization` checks for one channel, bot or thread written as SQL, so a
 * list holds what reading each one directly would allow.
 */
export interface Interface {
	/** The rule for the channels the actor is in, for queries that scope a list. */
	readonly reachesPod: Effect.Effect<ReachesPod, never, CurrentActor.Service>;
	/** The rule for the bots the actor reaches, for queries that scope a list. */
	readonly reachesAgent: Effect.Effect<ReachesAgent, never, CurrentActor.Service>;
	/** The rule for the threads the actor reaches, for queries that scope a list. */
	readonly reachesThread: Effect.Effect<ReachesThread, never, CurrentActor.Service>;
	/** The channels the actor is in, by name, with their standing in each. */
	readonly pods: (workspaceId: string) => Effect.Effect<PodStanding[], never, CurrentActor.Service>;
	/** The thread, with the actor's standing towards it. */
	readonly thread: (
		threadId: string,
	) => Effect.Effect<ThreadStanding, ResourceHidden, CurrentActor.Service>;
	/** The conversation by its id: a thread of one of the `CONVERSATION_TYPES`. */
	readonly conversation: (
		conversationId: string,
	) => Effect.Effect<schema.ThreadRow, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Visibility") {}

/** SQL for "somebody is in this channel", given the column naming it: `thread.podId`, `pod.id`. */
export type ReachesPod = (podId: SQLWrapper) => SQL<boolean>;

/** SQL for "somebody reaches this bot", given the column naming it: `agent.id`, `thread.hostAgentId`. */
export type ReachesAgent = (agentId: SQLWrapper) => SQL<boolean>;

/**
 * SQL for "somebody reaches this thread", given the columns naming it, its
 * workspace, type, conversation, channel and bot: `thread`, or an alias of it.
 */
export type ReachesThread = (row: ThreadReachColumns) => SQL<boolean>;

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Visibility");
	return Service.of({
		reachesPod: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(podId) =>
					reachesPodFor(podId, userId),
		),

		reachesAgent: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(agentId) =>
					reachesAgentFor(agentId, userId),
		),

		reachesThread: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(row) =>
					reachesThreadFor(row, userId),
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
					if (!standing) return yield* new ResourceHidden({ resource: "thread" });
					return standing;
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
											inArray(thread.type, [...CONVERSATION_TYPES]),
											reachesThreadFor(thread, userId),
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

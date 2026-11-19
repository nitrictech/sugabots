export * as Visibility from "./visibility.ts";

import { and, eq, inArray, type SQL, type SQLWrapper } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { OPENABLE_CONVERSATION_KINDS, placedConversation } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import {
	type ConversationReachColumns,
	type ConversationStanding,
	conversationStandingFor,
	ResourceHidden,
	reachesBotFor,
	reachesConversationFor,
	reachesProjectFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";

/**
 * What the current actor can see. A project's threads are seen by the
 * people in it; a bot, and its threads and automations, by whoever reaches the
 * bot; a collaboration by whoever sees the conversation it was opened from;
 * a direct message by the people in it. Lists are scoped by
 * `reachesProjectFor`, `reachesBotFor` and `reachesConversationFor`, the rules
 * `Authorization` checks for one project, bot or conversation written as SQL, so a
 * list holds what reading each one directly would allow.
 */
export interface Interface {
	/** The rule for the projects the actor is in, for queries that scope a list. */
	readonly reachesProject: Effect.Effect<ReachesProject, never, CurrentActor.Service>;
	/** The rule for the bots the actor reaches, for queries that scope a list. */
	readonly reachesBot: Effect.Effect<ReachesBot, never, CurrentActor.Service>;
	/** The rule for the conversations the actor reaches, for queries that scope a list. */
	readonly reachesConversation: Effect.Effect<ReachesConversation, never, CurrentActor.Service>;
	/** The conversation, of any kind, with the actor's standing towards it. */
	readonly conversationStanding: (
		conversationId: string,
	) => Effect.Effect<ConversationStanding, ResourceHidden, CurrentActor.Service>;
	/** The conversation people open by its id: one of the `OPENABLE_CONVERSATION_KINDS`. */
	readonly conversation: (
		conversationId: string,
	) => Effect.Effect<schema.PlacedConversationRow, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Visibility") {}

/** SQL for "somebody is in this project", given the column naming it: `placedConversation.projectId`, `project.id`. */
export type ReachesProject = (projectId: SQLWrapper) => SQL<boolean>;

/** SQL for "somebody reaches this bot", given the column naming it: `bot.id`, `placedConversation.botId`. */
export type ReachesBot = (botId: SQLWrapper) => SQL<boolean>;

/**
 * SQL for "somebody reaches this conversation", given the columns naming it, its
 * workspace, kind, root, project and bot: `placedConversation`, or an alias of it.
 */
export type ReachesConversation = (row: ConversationReachColumns) => SQL<boolean>;

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Visibility");
	return Service.of({
		reachesProject: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(projectId) =>
					reachesProjectFor(projectId, userId),
		),

		reachesBot: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(botId) =>
					reachesBotFor(botId, userId),
		),

		reachesConversation: Effect.map(
			CurrentActor.Service,
			({ userId }) =>
				(row) =>
					reachesConversationFor(row, userId),
		),

		conversationStanding: (conversationId) =>
			operation(
				"conversationStanding",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) =>
						conversationStandingFor(db, conversationId, userId),
					);
					if (!standing) return yield* new ResourceHidden({ resource: "conversation" });
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
									.from(placedConversation)
									.where(
										and(
											eq(placedConversation.id, conversationId),
											inArray(placedConversation.kind, [...OPENABLE_CONVERSATION_KINDS]),
											reachesConversationFor(placedConversation, userId),
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

export * as Visibility from "./visibility.ts";

import { and, eq, inArray, type SQL, type SQLWrapper } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import { OPENABLE_CHAT_KINDS, placedChat } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import {
	type ChatReachColumns,
	type ChatStanding,
	chatStandingFor,
	ResourceHidden,
	reachesBotFor,
	reachesChatFor,
	reachesProjectFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";

/**
 * What the current actor can see. A project's chats are seen by the
 * members in it; and a bot, and its chats and automations, by whoever reaches
 * the bot. Lists are scoped by
 * `reachesProjectFor`, `reachesBotFor` and `reachesChatFor`, the rules
 * `Authorization` checks for one project, bot or chat written as SQL, so a
 * list holds what reading each one directly would allow.
 */
export interface Interface {
	/** The rule for the projects the actor is in, for queries that scope a list. */
	readonly reachesProject: Effect.Effect<ReachesProject, never, CurrentActor.Service>;
	/** The rule for the bots the actor reaches, for queries that scope a list. */
	readonly reachesBot: Effect.Effect<ReachesBot, never, CurrentActor.Service>;
	/** The rule for the chats the actor reaches, for queries that scope a list. */
	readonly reachesChat: Effect.Effect<ReachesChat, never, CurrentActor.Service>;
	/** The chat, of any kind, with the actor's standing towards it. */
	readonly chatStanding: (
		chatId: string,
	) => Effect.Effect<ChatStanding, ResourceHidden, CurrentActor.Service>;
	/** The chat members open by its id: one of the `OPENABLE_CHAT_KINDS`. */
	readonly chat: (
		chatId: string,
	) => Effect.Effect<schema.PlacedChatRow, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Visibility") {}

/** SQL for "somebody is in this project", given the column naming it: `placedChat.projectId`, `project.id`. */
export type ReachesProject = (projectId: SQLWrapper) => SQL<boolean>;

/** SQL for "somebody reaches this bot", given the column naming it: `bot.id`, `placedChat.botId`. */
export type ReachesBot = (botId: SQLWrapper) => SQL<boolean>;

/**
 * SQL for "somebody reaches this chat", given the columns naming it, its
 * workspace, kind, root, project and bot: `placedChat`, or an alias of it.
 */
export type ReachesChat = (row: ChatReachColumns) => SQL<boolean>;

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Visibility");
	return Service.of({
		reachesProject: Effect.map(
			CurrentActor.Service,
			({ memberId }) =>
				(projectId) =>
					reachesProjectFor(projectId, memberId),
		),

		reachesBot: Effect.map(
			CurrentActor.Service,
			({ memberId }) =>
				(botId) =>
					reachesBotFor(botId, memberId),
		),

		reachesChat: Effect.map(
			CurrentActor.Service,
			({ memberId }) =>
				(row) =>
					reachesChatFor(row, memberId),
		),

		chatStanding: (chatId) =>
			operation(
				"chatStanding",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => chatStandingFor(db, chatId, memberId));
					if (!standing) return yield* new ResourceHidden({ resource: "chat" });
					return standing;
				}),
			),

		chat: (chatId) =>
			operation(
				"chat",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const [row] = isUuid(chatId)
						? yield* query((db) =>
								db
									.select()
									.from(placedChat)
									.where(
										and(
											eq(placedChat.id, chatId),
											inArray(placedChat.kind, [...OPENABLE_CHAT_KINDS]),
											reachesChatFor(placedChat, memberId),
										),
									)
									.limit(1),
							)
						: [];
					if (!row) return yield* new ResourceHidden({ resource: "chat" });
					return row;
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

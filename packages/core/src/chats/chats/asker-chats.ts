export * as AskerChats from "./asker-chats.ts";

import type { ProjectChat } from "@sugabots/contracts";
import { BotHasNoModel } from "@sugabots/contracts/errors/chats";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { ResourceHidden } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { bot, project } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { madeByMembers } from "../store/participants.ts";
import { ChatStore } from "../store/store.ts";
import { toProjectChat } from "./chat.ts";

/**
 * What a bot's chat tools do for its asker, as the current actor: start a
 * chat a brief opens, and mark a chat resolved. It exists only because those
 * tools (`start_chat` and `mark_resolved`, through `BotChats`) still call
 * services directly; it goes when tools become operations, called in the bot
 * loop like any other entrypoint's. The HTTP API goes through the chats
 * operations and the `Chats` service, which demands proofs.
 */
export interface Interface {
	/**
	 * Starts a chat for the principal with the bot `botId`, in its default
	 * project, which takes its turn on `brief`, the first message, written by
	 * the bot `briefingBotId` that started it for them. Refused unless the
	 * actor reaches that bot and it has a model.
	 */
	readonly startBriefedChat: (input: {
		workspaceId: string;
		botId: string;
		briefingBotId: string;
		title: string;
		brief: string;
	}) => Effect.Effect<ProjectChat, BotUnavailable | BotHasNoModel, CurrentActor.Service>;
	/**
	 * Marks the chat `chatId` resolved, or reopens it. An automation's
	 * feed is never resolved, so it is hidden from this.
	 */
	readonly setResolved: (input: {
		chatId: string;
		resolved: boolean;
	}) => Effect.Effect<void, ResourceHidden, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/AskerChats") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("AskerChats");
	const visibility = yield* Visibility.Service;
	const chats = yield* ChatStore.Service;

	return Service.of({
		startBriefedChat: (input) =>
			operation(
				"startBriefedChat",
				transaction(
					Effect.gen(function* () {
						const chatBot = yield* reachedBot(input, yield* visibility.reachesBot);
						if (!chatBot) return yield* new BotUnavailable();
						if (chatBot.model === null) return yield* new BotHasNoModel();
						const { memberId } = yield* CurrentActor.Service;
						return toProjectChat(
							yield* chats.startBriefedChat({
								workspaceId: input.workspaceId,
								projectId: chatBot.defaultProjectId,
								briefingBotId: input.briefingBotId,
								startedById: memberId,
								title: input.title,
								brief: input.brief,
							}),
						);
					}),
				),
			),

		setResolved: (input) =>
			operation(
				"setResolved",
				transaction(
					Effect.gen(function* () {
						const visible = yield* visibility.chat(input.chatId);
						// Only a project's chat is ever resolved, not an automation's feed.
						if (visible.kind !== "project_chat") {
							return yield* new ResourceHidden({ resource: "chat" });
						}
						yield* chats.setResolved(visible, input.resolved);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Visibility.layer, ChatStore.layer]));

/** The bot asked to chatBot the chat is out of the principal's reach, or not one members make. */
export class BotUnavailable extends Data.TaggedError("BotUnavailable") implements UserFacing {
	get userMessage() {
		return userText`That bot isn't available for this chat`;
	}
}

/**
 * The bot `input.botId`, with its model and default project, when
 * `reachesBot` reaches it, it is in the workspace, and members make it.
 */
const reachedBot = (
	input: { workspaceId: string; botId: string },
	reachesBot: Visibility.ReachesBot,
) =>
	Effect.map(
		query((db) =>
			db
				.select({ model: bot.model, defaultProjectId: project.id })
				.from(bot)
				.innerJoin(project, eq(project.defaultOfBotId, bot.id))
				.where(
					and(
						eq(bot.id, input.botId),
						eq(bot.workspaceId, input.workspaceId),
						madeByMembers,
						reachesBot(bot.id),
					),
				)
				.limit(1),
		),
		([chatBot]) => chatBot,
	);

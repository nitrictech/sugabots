export * as BotChats from "./bot-chats.ts";

import type { BotStartedChat } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { asAsker, type NobodyAsked } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { bot, chat } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import type { FloorControl } from "../floor/floor-control.ts";
import { madeByMembers } from "../store/participants.ts";
import { AskerChats } from "./asker-chats.ts";

/**
 * What a bot does to chats for the member whose message it is answering, with
 * their permissions: moves work that came up in one chat to a chat of
 * its own, one of a bot's chats, and marks a chat resolved. It cannot act for nobody: a
 * turn answering another bot, or an automation's run, is refused.
 */
export interface Interface {
	/**
	 * Starts a chat with the bot `withHandle`, or with the bot itself when that
	 * is absent. The new chat's bot works from `brief`, which the starting bot
	 * writes as its first message.
	 */
	readonly start: (bot: Bot, input: NewBotChat) => Effect.Effect<BotStartedChat, Refused>;
	/**
	 * Marks the chat `chatId` resolved. It stays resolved until somebody
	 * posts in it. An automation's feed is never resolved.
	 */
	readonly markResolved: (bot: Bot, chatId: string) => Effect.Effect<void, Refused>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotChats") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotChats");
	const chats = yield* AskerChats.Service;

	return Service.of({
		start: (bot, input) =>
			operation(
				"start",
				asAsker(
					bot.askerId,
					Effect.gen(function* () {
						const chatBot = input.withHandle
							? yield* botWithHandle(bot.workspaceId, input.withHandle)
							: { id: bot.botId, name: undefined };
						if (!chatBot) return yield* new NoBotWithHandle();
						const started = yield* chats.startBriefedChat({
							workspaceId: bot.workspaceId,
							botId: chatBot.id,
							briefingBotId: bot.botId,
							title: input.title,
							brief: input.brief,
						});
						const otherBot = chatBot.id === bot.botId ? undefined : chatBot.name;
						return {
							id: started.id,
							title: started.title,
							...(otherBot && { with: otherBot, withBotId: chatBot.id }),
						};
					}),
				),
			),

		markResolved: (bot, chatId) =>
			operation(
				"markResolved",
				asAsker(bot.askerId, chats.setResolved({ chatId, resolved: true })).pipe(
					Effect.catchTag("ResourceHidden", () =>
						Effect.flatMap(chatKind(bot.workspaceId, chatId), (kind) =>
							Effect.fail(
								kind !== undefined && kind !== "project_chat"
									? new NotAProjectChat()
									: new ChatHiddenFromAsker(),
							),
						),
					),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(AskerChats.layer));

/** The bot, where it is, and the member it acts for, if any. */
export interface Bot {
	readonly botId: string;
	readonly workspaceId: string;
	/**
	 * Whose permissions it acts with: the member whose message it is
	 * answering or, to mark its own chat resolved, the member a bot's brief
	 * started that chat for. None when nobody asked.
	 */
	readonly askerId: string | null;
}

export interface NewBotChat {
	title: string;
	/** What the chat's bot is to do, with what it needs from the chat it came from. */
	brief: string;
	/** The handle of the bot to start it with; the starting bot itself when absent. */
	withHandle?: string;
}

/** The workspace's bot with the handle `handle`, written with or without its `@`. */
const botWithHandle = (workspaceId: string, handle: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: bot.id, name: bot.name })
				.from(bot)
				.where(
					and(
						madeByMembers,
						eq(bot.workspaceId, workspaceId),
						sql`lower(${bot.handle}) = lower(${handle.trim().replace(/^@/, "")})`,
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

/** The kind of the workspace's chat `chatId`, if it has it. */
const chatKind = (workspaceId: string, chatId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ kind: chat.kind })
				.from(chat)
				.where(and(eq(chat.id, chatId), eq(chat.workspaceId, workspaceId)))
				.limit(1),
		),
		([row]) => row?.kind,
	);

/** Why the bot could not start the chat, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| NoBotWithHandle
	| NotAProjectChat
	| ChatHiddenFromAsker
	| AskerChats.BotUnavailable
	| FloorControl.BotHasNoModel;

export class NoBotWithHandle extends Data.TaggedError("NoBotWithHandle") implements UserFacing {
	get userMessage() {
		return userText`There is no bot with that handle to start a chat with.`;
	}
}

export class NotAProjectChat extends Data.TaggedError("NotAProjectChat") implements UserFacing {
	get userMessage() {
		return userText`Only a project's chat can be marked resolved, not an automation's feed or a run.`;
	}
}

export class ChatHiddenFromAsker
	extends Data.TaggedError("ChatHiddenFromAsker")
	implements UserFacing
{
	get userMessage() {
		return userText`The member this turn acts for can no longer see this chat, so it can't be marked resolved for them.`;
	}
}

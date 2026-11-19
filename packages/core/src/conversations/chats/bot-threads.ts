export * as BotThreads from "./bot-threads.ts";

import type { BotStartedThread } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { asAsker, type NobodyAsked } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { bot, conversation } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import type { FloorControl } from "../floor/floor-control.ts";
import { madeByPeople } from "../repository/participants.ts";
import { Chats } from "./chats.ts";

/**
 * What a bot does to threads for the person whose message it is answering, with
 * their permissions: moves work that came up in one conversation to a thread of
 * its own, one of a bot's threads, and marks a thread done. It cannot act for nobody: a
 * turn answering another bot, or an automation's run, is refused.
 */
export interface Interface {
	/**
	 * Starts a thread with the bot `withHandle`, or with the bot itself when that
	 * is absent. The new thread's bot works from `brief`, which the starting bot
	 * writes as its first message.
	 */
	readonly start: (bot: Bot, input: NewBotThread) => Effect.Effect<BotStartedThread, Refused>;
	/**
	 * Marks the thread `conversationId` done. It stays done until somebody
	 * posts in it. An automation's feed is never done.
	 */
	readonly markDone: (bot: Bot, conversationId: string) => Effect.Effect<void, Refused>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotThreads") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotThreads");
	const chats = yield* Chats.Service;

	return Service.of({
		start: (bot, input) =>
			operation(
				"start",
				asAsker(
					bot.askedBy,
					Effect.gen(function* () {
						const host = input.withHandle
							? yield* botWithHandle(bot.workspaceId, input.withHandle)
							: { id: bot.botId, name: undefined };
						if (!host) return yield* new NoBotWithHandle();
						const started = yield* chats.startBriefedThread({
							workspaceId: bot.workspaceId,
							botId: host.id,
							briefingBotId: bot.botId,
							title: input.title,
							brief: input.brief,
						});
						const otherBot = host.id === bot.botId ? undefined : host.name;
						return {
							id: started.id,
							title: started.title,
							...(otherBot && { with: otherBot, withBotId: host.id }),
						};
					}),
				),
			),

		markDone: (bot, conversationId) =>
			operation(
				"markDone",
				asAsker(bot.askedBy, chats.setDone({ conversationId, done: true })).pipe(
					Effect.catchTag("ResourceHidden", () =>
						Effect.flatMap(conversationKind(bot.workspaceId, conversationId), (kind) =>
							Effect.fail(
								kind !== undefined && kind !== "project_thread"
									? new NotAThread()
									: new ThreadHiddenFromAsker(),
							),
						),
					),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/**
 * Suspended, because `Chats` reaches the turn's steps, which reach this
 * module: `Chats.layer` is read once the layer is built, not while the
 * modules load.
 */
export const layer = Layer.suspend(() => layerNoDeps.pipe(Layer.provide(Chats.layer)));

/** The bot, where it is, and the person it acts for, if any. */
export interface Bot {
	readonly botId: string;
	readonly workspaceId: string;
	/**
	 * Whose permissions it acts with: the person whose message it is
	 * answering or, to mark its own thread done, the person a bot's brief
	 * started that thread for. None when nobody asked.
	 */
	readonly askedBy: string | null;
}

export interface NewBotThread {
	title: string;
	/** What the thread's bot is to do, with what it needs from the conversation it came from. */
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
						madeByPeople,
						eq(bot.workspaceId, workspaceId),
						sql`lower(${bot.handle}) = lower(${handle.trim().replace(/^@/, "")})`,
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

/** The kind of the workspace's conversation `conversationId`, if it has it. */
const conversationKind = (workspaceId: string, conversationId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ kind: conversation.kind })
				.from(conversation)
				.where(and(eq(conversation.id, conversationId), eq(conversation.workspaceId, workspaceId)))
				.limit(1),
		),
		([row]) => row?.kind,
	);

/** Why the bot could not start the conversation, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| NoBotWithHandle
	| NotAThread
	| ThreadHiddenFromAsker
	| Chats.HostUnavailable
	| FloorControl.BotHasNoModel;

export class NoBotWithHandle extends Data.TaggedError("NoBotWithHandle") implements UserFacing {
	get userMessage() {
		return userText`There is no bot with that handle to start a thread with.`;
	}
}

export class NotAThread extends Data.TaggedError("NotAThread") implements UserFacing {
	get userMessage() {
		return userText`Only a thread can be marked done, not an automation's feed or a collaboration.`;
	}
}

export class ThreadHiddenFromAsker
	extends Data.TaggedError("ThreadHiddenFromAsker")
	implements UserFacing
{
	get userMessage() {
		return userText`The person this turn acts for can no longer see this thread, so it can't be marked done for them.`;
	}
}

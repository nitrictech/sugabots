export * as BotThreads from "./bot-threads.ts";

import type { BotStartedThread } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, thread } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgent } from "../threads/participants.ts";
import { Chats } from "./chats.ts";

/**
 * What a bot does to tasks for the person whose message it is answering, with
 * their permissions: moves work that came up in one conversation to a task of
 * its own, and marks a task done. It cannot act for nobody: a
 * turn answering another bot, or a routine's trigger, is refused.
 */
export interface Interface {
	/**
	 * Starts a task with the bot `withHandle`, or with the bot itself when that
	 * is absent. The new task's bot works from `brief`, which the starting bot
	 * writes as its first message.
	 */
	readonly start: (bot: Bot, input: NewThread) => Effect.Effect<StartedThread, Refused>;
	/**
	 * Marks the task `conversationId` done. It stays done until somebody
	 * posts in it. A channel and an automation's thread are never done.
	 */
	readonly markDone: (bot: Bot, conversationId: string) => Effect.Effect<void, Refused>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotThreads") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotThreads");
	const chats = yield* Chats.Service;

	/**
	 * Runs `work` as the person the bot is answering. They signed in to post
	 * the message the turn answers, which is the claim `vouchedFor` makes.
	 */
	const forAsker = <A, E, R>(
		bot: Bot,
		work: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E | NobodyAsked, Exclude<R, CurrentActor.Service>> =>
		bot.askedBy
			? work.pipe(CurrentActor.provide(AuthenticatedUserId.vouchedFor(bot.askedBy)))
			: Effect.fail(new NobodyAsked());

	return Service.of({
		start: (bot, input) =>
			operation(
				"start",
				forAsker(
					bot,
					Effect.gen(function* () {
						const host = input.withHandle
							? yield* botWithHandle(bot.workspaceId, input.withHandle)
							: { id: bot.agentId, name: undefined };
						if (!host) return yield* new NoBotWithHandle();
						const started = yield* chats.startBriefedThread({
							workspaceId: bot.workspaceId,
							hostAgentId: host.id,
							briefingAgentId: bot.agentId,
							title: input.title,
							brief: input.brief,
						});
						const otherBot = host.id === bot.agentId ? undefined : host.name;
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
				forAsker(bot, chats.setDone({ conversationId, done: true })).pipe(
					Effect.catchTag("ResourceHidden", () =>
						Effect.flatMap(threadType(bot.workspaceId, conversationId), (type) =>
							Effect.fail(
								type !== undefined && type !== "conversation"
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
	readonly agentId: string;
	readonly workspaceId: string;
	/**
	 * Whose permissions it acts with: the person whose message it is
	 * answering or, to mark its own thread done, the person a bot's brief
	 * started that thread for. None when nobody asked.
	 */
	readonly askedBy: string | null;
}

export interface NewThread {
	title: string;
	/** What the thread's bot is to do, with what it needs from the thread it came from. */
	brief: string;
	/** The handle of the bot to start it with; the starting bot itself when absent. */
	withHandle?: string;
}

/** The thread as the bot that started it is told of it. */
export type StartedThread = BotStartedThread;

/** The workspace's bot with the handle `handle`, written with or without its `@`. */
const botWithHandle = (workspaceId: string, handle: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: agent.id, name: agent.name })
				.from(agent)
				.where(
					and(
						crewAgent,
						eq(agent.workspaceId, workspaceId),
						sql`lower(${agent.handle}) = lower(${handle.trim().replace(/^@/, "")})`,
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

/** The type of the workspace's thread `threadId`, if it has it. */
const threadType = (workspaceId: string, threadId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ type: thread.type })
				.from(thread)
				.where(and(eq(thread.id, threadId), eq(thread.workspaceId, workspaceId)))
				.limit(1),
		),
		([row]) => row?.type,
	);

/** Why the bot could not start the thread, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| NoBotWithHandle
	| NotAThread
	| ThreadHiddenFromAsker
	| Chats.HostNotCrew
	| Chats.HostHasNoModel;

export class NobodyAsked extends Data.TaggedError("NobodyAsked") implements UserFacing {
	get userMessage() {
		return userText`Only a person can ask a bot to start a task or mark one done, and this turn answers no one.`;
	}
}

export class NoBotWithHandle extends Data.TaggedError("NoBotWithHandle") implements UserFacing {
	get userMessage() {
		return userText`There is no bot with that handle to start a task with.`;
	}
}

export class NotAThread extends Data.TaggedError("NotAThread") implements UserFacing {
	get userMessage() {
		return userText`Only a task can be marked done, not a channel, an automation's thread or a collaboration.`;
	}
}

export class ThreadHiddenFromAsker
	extends Data.TaggedError("ThreadHiddenFromAsker")
	implements UserFacing
{
	get userMessage() {
		return userText`The person this turn acts for can no longer see this task, so it can't be marked done for them.`;
	}
}

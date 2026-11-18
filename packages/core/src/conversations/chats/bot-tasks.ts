export * as BotTasks from "./bot-tasks.ts";

import type { BotStartedTask } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, eq, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { bot, conversation } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { madeByPeople } from "../repository/participants.ts";
import { Chats } from "./chats.ts";

/**
 * What a bot does to tasks for the person whose message it is answering, with
 * their permissions: moves work that came up in one conversation to a task of
 * its own, and marks a task done. It cannot act for nobody: a
 * turn answering another bot, or an automation's trigger, is refused.
 */
export interface Interface {
	/**
	 * Starts a task with the bot `withHandle`, or with the bot itself when that
	 * is absent. The new task's bot works from `brief`, which the starting bot
	 * writes as its first message.
	 */
	readonly start: (bot: Bot, input: NewTask) => Effect.Effect<StartedTask, Refused>;
	/**
	 * Marks the task `conversationId` done. It stays done until somebody
	 * posts in it. A channel and an automation's feed are never done.
	 */
	readonly markDone: (bot: Bot, conversationId: string) => Effect.Effect<void, Refused>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotTasks") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotTasks");
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
							: { id: bot.botId, name: undefined };
						if (!host) return yield* new NoBotWithHandle();
						const started = yield* chats.startBriefedTask({
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
				forAsker(bot, chats.setDone({ conversationId, done: true })).pipe(
					Effect.catchTag("ResourceHidden", () =>
						Effect.flatMap(conversationKind(bot.workspaceId, conversationId), (kind) =>
							Effect.fail(
								kind !== undefined && kind !== "task" ? new NotATask() : new TaskHiddenFromAsker(),
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
	 * answering or, to mark its own task done, the person a bot's brief
	 * started that task for. None when nobody asked.
	 */
	readonly askedBy: string | null;
}

export interface NewTask {
	title: string;
	/** What the task's bot is to do, with what it needs from the conversation it came from. */
	brief: string;
	/** The handle of the bot to start it with; the starting bot itself when absent. */
	withHandle?: string;
}

/** The task as the bot that started it is told of it. */
export type StartedTask = BotStartedTask;

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
	| NotATask
	| TaskHiddenFromAsker
	| Chats.HostUnavailable
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

export class NotATask extends Data.TaggedError("NotATask") implements UserFacing {
	get userMessage() {
		return userText`Only a task can be marked done, not a channel's conversation, an automation's feed or a collaboration.`;
	}
}

export class TaskHiddenFromAsker
	extends Data.TaggedError("TaskHiddenFromAsker")
	implements UserFacing
{
	get userMessage() {
		return userText`The person this turn acts for can no longer see this task, so it can't be marked done for them.`;
	}
}

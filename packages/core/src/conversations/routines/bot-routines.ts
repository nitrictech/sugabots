export * as BotRoutines from "./bot-routines.ts";

import type { Routine, RoutineResults } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, pod, workspace } from "../../database/schema.ts";
import { Installation } from "../../installation/installation.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import type { RoutineRepository } from "./repository.ts";
import type { RoutineNotFound } from "./routine.ts";
import { Routines } from "./routines.ts";
import type { InvalidRoutineSchedule } from "./schedule.ts";

/**
 * A bot's own routines, as it reads and changes them in a conversation, for
 * the person whose message it is answering and with their permissions. It
 * cannot act for nobody: a turn answering another bot, or a routine's
 * trigger, is refused.
 *
 * A bot sets up schedules only, in its workspace's timezone, and records
 * itself as their maker. A webhook's secret is shown once, so a webhook made
 * here would leave it in the conversation; webhooks are made in settings.
 */
export interface Interface {
	readonly list: (bot: Bot) => Effect.Effect<BotRoutine[], Refused>;
	readonly create: (bot: Bot, input: NewBotRoutine) => Effect.Effect<BotRoutine, Refused>;
	/** Changes one of the bot's routines. A webhook routine's trigger stays as it is. */
	readonly update: (
		bot: Bot,
		routineId: string,
		changes: BotRoutineChanges,
	) => Effect.Effect<BotRoutine, Refused>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/BotRoutines") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotRoutines");
	const routines = yield* Routines.Service;
	const installation = yield* Installation.Service;

	/** Where the bot lives: its workspace's timezone, and the settings page listing its routines. */
	const placeOf = (agentId: string) =>
		Effect.flatMap(
			query((db) =>
				db
					.select({
						timeZone: workspace.timeZone,
						workspaceSlug: workspace.slug,
						podSlug: pod.slug,
						handle: agent.handle,
					})
					.from(agent)
					.innerJoin(workspace, eq(workspace.id, agent.workspaceId))
					.innerJoin(pod, eq(pod.id, agent.podId))
					.where(eq(agent.id, agentId))
					.limit(1),
			),
			([row]) =>
				row
					? Effect.succeed({
							timeZone: row.timeZone,
							settingsUrl: `${installation.webAppUrl}/${row.workspaceSlug}/settings/pods/${row.podSlug}/agents/${row.handle}?tab=routines`,
						})
					: Effect.die(new Error("A bot with routines is not in a pod")),
		);

	/**
	 * Runs `work` as the person the bot is answering. They signed in to post
	 * the message the turn answers, which is the claim `vouchedFor` makes.
	 */
	const forAsker = <A, E>(
		bot: Bot,
		work: Effect.Effect<A, E | AuthorizationDenied, CurrentActor.Service>,
	) =>
		bot.askedBy
			? work.pipe(
					CurrentActor.provide(AuthenticatedUserId.vouchedFor(bot.askedBy)),
					Effect.catchTag(["ActionForbidden", "ResourceHidden"], () =>
						Effect.fail(new MayNotManageRoutines()),
					),
				)
			: Effect.fail(new NobodyAsked());

	return Service.of({
		list: (bot) =>
			operation(
				"list",
				Effect.gen(function* () {
					const listed = yield* forAsker(bot, routines.list({ agentId: bot.agentId }));
					const place = yield* placeOf(bot.agentId);
					return listed.map((routine) => toBotRoutine(routine, place.settingsUrl));
				}),
			),

		create: (bot, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.agentId);
					const defined = yield* forAsker(
						bot,
						routines.create(
							{ agentId: bot.agentId, madeByAgent: true },
							{
								name: input.name,
								instructions: input.instructions,
								results: input.results,
								trigger: { kind: "cron", expression: input.schedule, timezone: place.timeZone },
							},
						),
					);
					return toBotRoutine(defined.routine, place.settingsUrl);
				}),
			),

		update: (bot, routineId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.agentId);
					const addressed = { agentId: bot.agentId, routineId };
					const current = yield* forAsker(bot, routines.get(addressed));
					if (changes.schedule !== undefined && current.trigger.kind === "webhook") {
						return yield* new WebhookKeepsItsTrigger();
					}
					const updated = yield* forAsker(
						bot,
						routines.update(addressed, {
							name: changes.name,
							instructions: changes.instructions,
							results: changes.results,
							state:
								changes.paused === undefined ? undefined : changes.paused ? "paused" : "enabled",
							trigger:
								changes.schedule === undefined
									? undefined
									: { kind: "cron", expression: changes.schedule, timezone: place.timeZone },
						}),
					);
					return toBotRoutine(updated.routine, place.settingsUrl);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

/**
 * Suspended, because `Routines` reaches the turn's steps, which reach this
 * module: `Routines.layer` is read once the layer is built, not while the
 * modules load.
 */
export const layer = Layer.suspend(() => layerNoDeps.pipe(Layer.provide(Routines.layer)));

/** The bot and the person whose message it is answering, if a person asked. */
export interface Bot {
	readonly agentId: string;
	readonly askedBy: string | null;
}

/** A routine as the bot reads it back. */
export interface BotRoutine {
	id: string;
	name: string;
	instructions: string;
	/** A cron expression and the timezone it runs in, or a webhook, which only settings change. */
	when:
		| { kind: "schedule"; schedule: string; timezone: string; nextRunAt: string | null }
		| { kind: "webhook" };
	paused: boolean;
	results: RoutineResults;
	/** The settings page listing the bot's routines, for a link in its reply. */
	settingsUrl: string;
}

export interface NewBotRoutine {
	name: string;
	instructions: string;
	/** A five-field cron expression, in the workspace's timezone. */
	schedule: string;
	results: RoutineResults;
}

export interface BotRoutineChanges {
	name?: string;
	instructions?: string;
	schedule?: string;
	results?: RoutineResults;
	paused?: boolean;
}

function toBotRoutine(routine: Routine, settingsUrl: string): BotRoutine {
	return {
		id: routine.id,
		name: routine.name,
		instructions: routine.instructions,
		when:
			routine.trigger.kind === "cron"
				? {
						kind: "schedule",
						schedule: routine.trigger.expression,
						timezone: routine.trigger.timezone,
						nextRunAt: routine.trigger.nextScheduledAt,
					}
				: { kind: "webhook" },
		paused: routine.state === "paused",
		results: routine.results,
		settingsUrl,
	};
}

/** Why the bot could not do what it was asked, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| MayNotManageRoutines
	| WebhookKeepsItsTrigger
	| RoutineNotFound
	| RoutineRepository.RoutineNameTaken
	| InvalidRoutineSchedule;

export class NobodyAsked extends Data.TaggedError("NobodyAsked") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Only a person can ask a bot to read or change its routines, and this turn answers no one.`;
	}
}

export class MayNotManageRoutines
	extends Data.TaggedError("MayNotManageRoutines")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The person asking may not do that: only an admin of this pod can have a bot set up or change its routines.`;
	}
}

export class WebhookKeepsItsTrigger
	extends Data.TaggedError("WebhookKeepsItsTrigger")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That routine runs on a webhook, which only its settings can change. Its name, instructions, results and whether it is paused can still be changed here.`;
	}
}

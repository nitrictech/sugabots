export * as BotRoutines from "./bot-routines.ts";

import type {
	RepositoryEvent,
	Routine,
	RoutineResults,
	RoutineSchedule,
	RoutineTrigger,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { AuthenticatedUserId, CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, workspace } from "../../database/schema.ts";
import { Installation } from "../../installation/installation.ts";
import type { UserFacing } from "../../user-message.ts";
import type { RoutineRepository } from "./repository.ts";
import type {
	RoutineChatNotFound,
	RoutineNotFound,
	RoutineRepositoryNotInPod,
	RoutineTriggerKindChanged,
	RoutineTriggerNotFound,
	WebhookSecretTooShort,
} from "./routine.ts";
import { Routines } from "./routines.ts";
import type { InvalidRoutineSchedule } from "./schedule.ts";

/**
 * A bot's own routines, as it reads and changes them in a conversation, for
 * the person whose message it is answering and with their permissions. It
 * cannot act for nobody: a turn answering another bot, or a routine's
 * trigger, is refused.
 *
 * A bot sets up routines on one schedule, in its workspace's timezone, and
 * records itself as their maker; it changes that schedule while it is the
 * routine's only trigger. Other triggers are set up in settings: a webhook's
 * secret is shown once, so one made here would leave it in the conversation.
 */
export interface Interface {
	readonly list: (bot: Bot) => Effect.Effect<BotRoutine[], Refused>;
	readonly create: (bot: Bot, input: NewBotRoutine) => Effect.Effect<BotRoutine, Refused>;
	/** Changes one of the bot's routines. Its schedule changes only while that is its only trigger. */
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

	/** Where the bot lives: its workspace's timezone, and where its routines' settings pages are. */
	const placeOf = (agentId: string) =>
		Effect.flatMap(
			query((db) =>
				db
					.select({
						timeZone: workspace.timeZone,
						workspaceSlug: workspace.slug,
					})
					.from(agent)
					.innerJoin(workspace, eq(workspace.id, agent.workspaceId))
					.where(eq(agent.id, agentId))
					.limit(1),
			),
			([row]) =>
				row
					? Effect.succeed({
							timeZone: row.timeZone,
							routinesUrl: `${installation.webAppUrl}/${row.workspaceSlug}/settings/routines`,
						})
					: Effect.die(new Error("A bot with routines is not in a workspace")),
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
					return listed.map((routine) => toBotRoutine(routine, place.routinesUrl));
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
								triggers: [
									{
										kind: "cron",
										schedule: { repeat: "cron", expression: input.schedule },
										timezone: place.timeZone,
									},
								],
							},
						),
					);
					return toBotRoutine(defined.routine, place.routinesUrl);
				}),
			),

		update: (bot, routineId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const place = yield* placeOf(bot.agentId);
					const addressed = { agentId: bot.agentId, routineId };
					const current = yield* forAsker(bot, routines.get(addressed));
					const [only, ...others] = current.triggers;
					if (changes.schedule !== undefined && (only?.kind !== "cron" || others.length > 0)) {
						return yield* new TriggerSetInSettings();
					}
					const updated = yield* forAsker(
						bot,
						routines.update(addressed, {
							name: changes.name,
							instructions: changes.instructions,
							results: changes.results,
							state:
								changes.paused === undefined ? undefined : changes.paused ? "paused" : "enabled",
						}),
					);
					if (changes.schedule === undefined || !only) {
						return toBotRoutine(updated.routine, place.routinesUrl);
					}
					const rescheduled = yield* forAsker(
						bot,
						routines.updateTrigger(
							{ ...addressed, triggerId: only.id },
							{
								kind: "cron",
								schedule: { repeat: "cron", expression: changes.schedule },
								timezone: place.timeZone,
							},
						),
					);
					return toBotRoutine(rescheduled.routine, place.routinesUrl);
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
	/**
	 * What starts it: each schedule and the timezone it runs in, a webhook, or
	 * a repository's events. A schedule the bot set is a cron expression; one
	 * picked in settings is by its days and times. With none, it runs only when
	 * someone runs it.
	 */
	when: Array<
		| { kind: "schedule"; schedule: RoutineSchedule; timezone: string; nextRunAt: string | null }
		| { kind: "webhook" }
		| { kind: "github"; repository: string; events: readonly RepositoryEvent[] }
	>;
	paused: boolean;
	results: RoutineResults;
	/** The routine's own settings page, for a link in the bot's reply. */
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

function whenOf(trigger: RoutineTrigger): BotRoutine["when"][number] {
	switch (trigger.kind) {
		case "cron":
			return {
				kind: "schedule",
				schedule: trigger.schedule,
				timezone: trigger.timezone,
				nextRunAt: trigger.nextScheduledAt,
			};
		case "webhook":
			return { kind: "webhook" };
		case "github":
			return { kind: "github", repository: trigger.repository, events: trigger.events };
	}
}

function toBotRoutine(routine: Routine, routinesUrl: string): BotRoutine {
	return {
		id: routine.id,
		name: routine.name,
		instructions: routine.instructions,
		when: routine.triggers.map(whenOf),
		paused: routine.state === "paused",
		results: routine.results,
		settingsUrl: `${routinesUrl}/${routine.id}`,
	};
}

/** Why the bot could not do what it was asked, in words it can pass on. */
export type Refused =
	| NobodyAsked
	| MayNotManageRoutines
	| TriggerSetInSettings
	| RoutineNotFound
	| RoutineChatNotFound
	| RoutineRepository.RoutineNameTaken
	| InvalidRoutineSchedule
	| WebhookSecretTooShort
	| RoutineRepositoryNotInPod
	| RoutineTriggerNotFound
	| RoutineTriggerKindChanged;

export class NobodyAsked extends Data.TaggedError("NobodyAsked") implements UserFacing {
	get userMessage() {
		return userText`Only a person can ask a bot to read or change its routines, and this turn answers no one.`;
	}
}

export class MayNotManageRoutines
	extends Data.TaggedError("MayNotManageRoutines")
	implements UserFacing
{
	get userMessage() {
		return userText`The person asking may not do that: only an admin of this pod can have a bot set up or change its routines.`;
	}
}

export class TriggerSetInSettings
	extends Data.TaggedError("TriggerSetInSettings")
	implements UserFacing
{
	get userMessage() {
		return userText`That routine has triggers other than one schedule, which only its settings can change. Its name, instructions, results and whether it is paused can still be changed here.`;
	}
}
